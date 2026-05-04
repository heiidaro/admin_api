import {
  Client,
  Databases,
  ID,
  Query,
  Users,
} from "node-appwrite";

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function getBody(req) {
  try {
    if (req.bodyJson && typeof req.bodyJson === "object") {
      return req.bodyJson;
    }

    if (typeof req.body === "string" && req.body.trim()) {
      return JSON.parse(req.body);
    }

    return {};
  } catch {
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isAdminUser(user) {
  const labels = Array.isArray(user?.labels) ? user.labels : [];
  return labels.includes("admin");
}

function isAdminProfile(profile) {
  return String(profile?.role || "").toLowerCase() === "admin";
}

function assertTargetIsNotAdmin(targetUser, targetProfile) {
  if (isAdminUser(targetUser) || isAdminProfile(targetProfile)) {
    const error = new Error("Нельзя изменять или блокировать администратора");
    error.statusCode = 403;
    throw error;
  }
}

function getUserDisplayName(user) {
  return user?.name || user?.email || "Пользователь";
}

function normalizeProfile(profile) {
  if (!profile) {
    return null;
  }

  return {
    profileId: profile.$id,
    userId: profile.userId || "",
    name: profile.name || "",
    email: profile.email || "",
    role: profile.role || "user",
    isBlocked: Boolean(profile.isBlocked),
    lastSeenAt: profile.lastSeenAt || "",
    lastActivityAt: profile.lastActivityAt || "",
    lastActivityScreen: profile.lastActivityScreen || "",
  };
}

function getOnlineStatus(lastSeenAt) {
  if (!lastSeenAt) {
    return "offline";
  }

  const lastSeenTime = new Date(lastSeenAt).getTime();

  if (Number.isNaN(lastSeenTime)) {
    return "offline";
  }

  const diffMs = Date.now() - lastSeenTime;

  if (diffMs < 0) {
    return "offline";
  }

  const diffMinutes = diffMs / 1000 / 60;

  if (diffMinutes <= 2) {
    return "online";
  }

  if (diffMinutes <= 15) {
    return "recently";
  }

  return "offline";
}

function createAppwriteClient() {
  const endpoint = getEnv("APPWRITE_FUNCTION_API_ENDPOINT");
  const projectId = getEnv("APPWRITE_FUNCTION_PROJECT_ID");
  const apiKey = getEnv("APPWRITE_API_KEY");

  if (!apiKey) {
    throw new Error("APPWRITE_API_KEY не указан в переменных функции");
  }

  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setKey(apiKey);

  return {
    client,
    users: new Users(client),
    databases: new Databases(client),
  };
}

function getConfig() {
  return {
    dbId: getEnv("DB_ID"),
    profilesColId: getEnv("PROFILES_COL_ID", "profiles"),
    supportTicketsColId: getEnv("SUPPORT_TICKETS_COL_ID", "support_tickets"),
    notificationsColId: getEnv("NOTIFICATIONS_COL_ID", "notifications"),
    adminLogsColId: getEnv("ADMIN_LOGS_COL_ID", "admin_logs"),
    appNewsColId: getEnv("APP_NEWS_COL_ID", "app_news"),
  };
}

async function listAllUsers(users) {
  const result = await users.list({
    queries: [
      Query.limit(100),
      Query.orderDesc("$createdAt"),
    ],
  });

  return result.users || [];
}

async function listAllProfiles(databases, config) {
  const result = await databases.listDocuments({
    databaseId: config.dbId,
    collectionId: config.profilesColId,
    queries: [
      Query.limit(100),
    ],
  });

  return result.documents || [];
}

async function findProfileByUserId(databases, config, userId) {
  const result = await databases.listDocuments({
    databaseId: config.dbId,
    collectionId: config.profilesColId,
    queries: [
      Query.equal("userId", userId),
      Query.limit(1),
    ],
  });

  return result.documents?.[0] || null;
}

async function ensureProfileForUser(databases, config, user) {
  const existingProfile = await findProfileByUserId(
    databases,
    config,
    user.$id
  );

  if (existingProfile) {
    const shouldUpdate =
      existingProfile.email !== user.email ||
      existingProfile.name !== user.name ||
      (isAdminUser(user) && existingProfile.role !== "admin");

    if (!shouldUpdate) {
      return existingProfile;
    }

    return databases.updateDocument({
      databaseId: config.dbId,
      collectionId: config.profilesColId,
      documentId: existingProfile.$id,
      data: {
        name: user.name || existingProfile.name || "",
        email: user.email || existingProfile.email || "",
        role: isAdminUser(user) ? "admin" : existingProfile.role || "user",
      },
    });
  }

  return databases.createDocument({
    databaseId: config.dbId,
    collectionId: config.profilesColId,
    documentId: ID.unique(),
    data: {
      userId: user.$id,
      name: user.name || "",
      email: user.email || "",
      role: isAdminUser(user) ? "admin" : "user",
      isBlocked: false,
      lastSeenAt: "",
      lastActivityAt: "",
      lastActivityScreen: "",
    },
  });
}

async function createAdminLog(databases, config, data) {
  return databases.createDocument({
    databaseId: config.dbId,
    collectionId: config.adminLogsColId,
    documentId: ID.unique(),
    data: {
      adminUserId: data.adminUserId,
      actionType: data.actionType,
      targetUserId: data.targetUserId || "",
      targetEntityId: data.targetEntityId || "",
      description: data.description,
    },
  });
}

async function requireAdmin(req, users) {
  const callerUserId = req.headers["x-appwrite-user-id"];

  if (!callerUserId) {
    const error = new Error("Пользователь не авторизован");
    error.statusCode = 401;
    throw error;
  }

  const caller = await users.get({
    userId: callerUserId,
  });

  if (!isAdminUser(caller)) {
    const error = new Error("Нет доступа. Требуется роль администратора");
    error.statusCode = 403;
    throw error;
  }

  return caller;
}

async function actionGetMeAdminStatus({ adminUser }) {
  return {
    isAdmin: true,
    admin: {
      userId: adminUser.$id,
      name: adminUser.name || "",
      email: adminUser.email || "",
      labels: adminUser.labels || [],
    },
  };
}

async function actionListUsers({ users, databases, config }) {
  const [authUsers, profiles] = await Promise.all([
    listAllUsers(users),
    listAllProfiles(databases, config),
  ]);

  const profilesByUserId = new Map();

  profiles.forEach((profile) => {
    if (profile.userId) {
      profilesByUserId.set(profile.userId, profile);
    }
  });

  const result = [];

  for (const user of authUsers) {
    let profile = profilesByUserId.get(user.$id);

    if (!profile) {
      profile = await ensureProfileForUser(databases, config, user);
    }

    const normalizedProfile = normalizeProfile(profile);
    const isAdmin = isAdminUser(user);

    result.push({
      userId: user.$id,
      name: normalizedProfile?.name || user.name || "",
      email: normalizedProfile?.email || user.email || "",
      phone: user.phone || "",
      status: Boolean(user.status),
      emailVerification: Boolean(user.emailVerification),
      labels: user.labels || [],
      createdAt: user.$createdAt || "",
      updatedAt: user.$updatedAt || "",

      profileId: normalizedProfile?.profileId || "",
      role: isAdmin ? "admin" : normalizedProfile?.role || "user",
      isBlocked: !user.status || Boolean(normalizedProfile?.isBlocked),
      lastSeenAt: normalizedProfile?.lastSeenAt || "",
      lastActivityAt: normalizedProfile?.lastActivityAt || "",
      lastActivityScreen: normalizedProfile?.lastActivityScreen || "",
      onlineStatus: getOnlineStatus(normalizedProfile?.lastSeenAt),
    });
  }

  return {
    users: result,
  };
}

async function actionGetDashboardStats({ users, databases, config }) {
  const [authUsers, profilesResult, ticketsResult] = await Promise.all([
    listAllUsers(users),
    databases.listDocuments({
      databaseId: config.dbId,
      collectionId: config.profilesColId,
      queries: [Query.limit(100)],
    }),
    databases.listDocuments({
      databaseId: config.dbId,
      collectionId: config.supportTicketsColId,
      queries: [Query.limit(100)],
    }),
  ]);

  const profiles = profilesResult.documents || [];
  const tickets = ticketsResult.documents || [];

  const blockedProfiles = profiles.filter((profile) => profile.isBlocked);
  const activeToday = profiles.filter((profile) => {
    if (!profile.lastSeenAt) {
      return false;
    }

    const seenDate = new Date(profile.lastSeenAt);
    const now = new Date();

    return (
      seenDate.getFullYear() === now.getFullYear() &&
      seenDate.getMonth() === now.getMonth() &&
      seenDate.getDate() === now.getDate()
    );
  });

  const openTickets = tickets.filter((ticket) => ticket.status === "open");
  const inProgressTickets = tickets.filter(
    (ticket) => ticket.status === "in_progress"
  );
  const closedTickets = tickets.filter((ticket) => ticket.status === "closed");

  return {
    stats: {
      totalUsers: authUsers.length,
      activeToday: activeToday.length,
      blockedUsers: blockedProfiles.length,
      openTickets: openTickets.length,
      inProgressTickets: inProgressTickets.length,
      closedTickets: closedTickets.length,
      totalTickets: tickets.length,
    },
  };
}

async function actionUpdateUserProfile({
  adminUser,
  users,
  databases,
  config,
  payload,
}) {
  const targetUserId = payload.userId;
  const name = String(payload.name || "").trim();
  const email = String(payload.email || "").trim();
  const password = String(payload.password || "").trim();
  const role = String(payload.role || "user").trim();

  if (!targetUserId) {
    throw new Error("Не передан userId пользователя");
  }

  if (!name) {
    throw new Error("Введите имя пользователя");
  }

  if (!email) {
    throw new Error("Введите email пользователя");
  }

  if (password && password.length < 8) {
    throw new Error("Пароль должен быть не короче 8 символов");
  }

  const targetUser = await users.get({
    userId: targetUserId,
  });

  const profile = await ensureProfileForUser(databases, config, targetUser);

  assertTargetIsNotAdmin(targetUser, profile);

  if (targetUser.name !== name) {
    await users.updateName({
      userId: targetUserId,
      name,
    });
  }

  if (targetUser.email !== email) {
    await users.updateEmail({
      userId: targetUserId,
      email,
    });
  }

  if (password) {
    await users.updatePassword({
      userId: targetUserId,
      password,
    });
  }

  const updatedProfile = await databases.updateDocument({
    databaseId: config.dbId,
    collectionId: config.profilesColId,
    documentId: profile.$id,
    data: {
      name,
      email,
      role: role === "admin" ? "admin" : "user",
    },
  });

  await createAdminLog(databases, config, {
    adminUserId: adminUser.$id,
    actionType: "update_user",
    targetUserId,
    targetEntityId: profile.$id,
    description: `Администратор обновил данные пользователя ${email}`,
  });

  return {
    profile: updatedProfile,
  };
}

async function actionBlockUser({
  adminUser,
  users,
  databases,
  config,
  payload,
}) {
  const targetUserId = payload.userId;

  if (!targetUserId) {
    throw new Error("Не передан userId пользователя");
  }

  if (targetUserId === adminUser.$id) {
    throw new Error("Нельзя заблокировать самого себя");
  }

  const targetUser = await users.get({
    userId: targetUserId,
  });

  const profile = await ensureProfileForUser(databases, config, targetUser);

  assertTargetIsNotAdmin(targetUser, profile);

  await users.updateStatus({
    userId: targetUserId,
    status: false,
  });

  const updatedProfile = await databases.updateDocument({
    databaseId: config.dbId,
    collectionId: config.profilesColId,
    documentId: profile.$id,
    data: {
      isBlocked: true,
    },
  });

  await createAdminLog(databases, config, {
    adminUserId: adminUser.$id,
    actionType: "block_user",
    targetUserId,
    targetEntityId: profile.$id,
    description: `Администратор заблокировал пользователя ${getUserDisplayName(
      targetUser
    )}`,
  });

  return {
    userId: targetUserId,
    profile: updatedProfile,
  };
}

async function actionUnblockUser({
  adminUser,
  users,
  databases,
  config,
  payload,
}) {
  const targetUserId = payload.userId;

  if (!targetUserId) {
    throw new Error("Не передан userId пользователя");
  }

  const targetUser = await users.get({
    userId: targetUserId,
  });

  const profile = await ensureProfileForUser(databases, config, targetUser);

  assertTargetIsNotAdmin(targetUser, profile);

  await users.updateStatus({
    userId: targetUserId,
    status: true,
  });

  const updatedProfile = await databases.updateDocument({
    databaseId: config.dbId,
    collectionId: config.profilesColId,
    documentId: profile.$id,
    data: {
      isBlocked: false,
    },
  });

  await createAdminLog(databases, config, {
    adminUserId: adminUser.$id,
    actionType: "unblock_user",
    targetUserId,
    targetEntityId: profile.$id,
    description: `Администратор разблокировал пользователя ${getUserDisplayName(
      targetUser
    )}`,
  });

  return {
    userId: targetUserId,
    profile: updatedProfile,
  };
}

async function actionListSupportTickets({ users, databases, config, payload }) {
  const status = payload.status || "all";

  const queries = [
    Query.orderDesc("$createdAt"),
    Query.limit(100),
  ];

  if (status !== "all") {
    queries.unshift(Query.equal("status", status));
  }

  const ticketsResult = await databases.listDocuments({
    databaseId: config.dbId,
    collectionId: config.supportTicketsColId,
    queries,
  });

  const tickets = ticketsResult.documents || [];

  const authUsers = await listAllUsers(users);

  const usersById = new Map();

  authUsers.forEach((user) => {
    usersById.set(user.$id, user);
  });

  const enrichedTickets = tickets.map((ticket) => {
    const user = usersById.get(ticket.userId);

    return {
      ...ticket,
      userName: user?.name || "Пользователь",
      userEmail: user?.email || "Email не найден",
    };
  });

  return {
    tickets: enrichedTickets,
  };
}

async function actionReplySupportTicket({
  adminUser,
  databases,
  config,
  payload,
}) {
  const ticketId = payload.ticketId;
  const replyText = String(payload.replyText || "").trim();
  const closeAfterReply = Boolean(payload.closeAfterReply);

  if (!ticketId) {
    throw new Error("Не передан ticketId обращения");
  }

  if (!replyText) {
    throw new Error("Введите ответ пользователю");
  }

  const ticket = await databases.getDocument({
    databaseId: config.dbId,
    collectionId: config.supportTicketsColId,
    documentId: ticketId,
  });

  const newStatus = closeAfterReply ? "closed" : "in_progress";

  const updatedTicket = await databases.updateDocument({
    databaseId: config.dbId,
    collectionId: config.supportTicketsColId,
    documentId: ticketId,
    data: {
      adminReply: replyText,
      adminReplyAt: nowIso(),
      isReplyRead: false,
      assignedAdminId: adminUser.$id,
      status: newStatus,
      closedAt: closeAfterReply ? nowIso() : "",
    },
  });

  await databases.createDocument({
    databaseId: config.dbId,
    collectionId: config.notificationsColId,
    documentId: ID.unique(),
    data: {
      userId: ticket.userId,
      title: "Получен ответ поддержки",
      message: `По обращению "${ticket.title}" появился ответ администратора.`,
      type: "support",
      isRead: false,
      relatedEntityId: ticketId,
      relatedEntityType: "support",
    },
  });

  await createAdminLog(databases, config, {
    adminUserId: adminUser.$id,
    actionType: "reply_ticket",
    targetUserId: ticket.userId,
    targetEntityId: ticketId,
    description: `Администратор ответил на обращение "${ticket.title}"`,
  });

  return {
    ticket: updatedTicket,
  };
}

async function actionCloseSupportTicket({
  adminUser,
  databases,
  config,
  payload,
}) {
  const ticketId = payload.ticketId;

  if (!ticketId) {
    throw new Error("Не передан ticketId обращения");
  }

  const ticket = await databases.getDocument({
    databaseId: config.dbId,
    collectionId: config.supportTicketsColId,
    documentId: ticketId,
  });

  const updatedTicket = await databases.updateDocument({
    databaseId: config.dbId,
    collectionId: config.supportTicketsColId,
    documentId: ticketId,
    data: {
      status: "closed",
      closedAt: nowIso(),
      assignedAdminId: adminUser.$id,
    },
  });

  await createAdminLog(databases, config, {
    adminUserId: adminUser.$id,
    actionType: "close_ticket",
    targetUserId: ticket.userId,
    targetEntityId: ticketId,
    description: `Администратор закрыл обращение "${ticket.title}"`,
  });

  return {
    ticket: updatedTicket,
  };
}

async function actionPublishNews({
  adminUser,
  users,
  databases,
  config,
  payload,
}) {
  const title = String(payload.title || "").trim();
  const message = String(payload.message || "").trim();
  const rawType = String(payload.type || "news").trim();

  const allowedTypes = ["news", "system", "update"];
  const type = allowedTypes.includes(rawType) ? rawType : "news";

  if (!title) {
    throw new Error("Введите заголовок новости");
  }

  if (!message) {
    throw new Error("Введите текст новости");
  }

  const safeTitle = title.slice(0, 250);
  const safeMessage = message.slice(0, 3900);
  const notificationMessage = message.slice(0, 1900);

  const news = await databases.createDocument({
    databaseId: config.dbId,
    collectionId: config.appNewsColId,
    documentId: ID.unique(),
    data: {
      title: safeTitle,
      message: safeMessage,
      type,
      isPublished: true,
      publishedAt: nowIso(),
      createdByUserId: adminUser.$id,
    },
  });

  const authUsers = await listAllUsers(users);

  const notificationErrors = [];

  for (const user of authUsers) {
    if (!user.status) {
      continue;
    }

    try {
      await databases.createDocument({
        databaseId: config.dbId,
        collectionId: config.notificationsColId,
        documentId: ID.unique(),
        data: {
          userId: user.$id,
          title: safeTitle,
          message: notificationMessage,
          type: "news",
          isRead: false,
          relatedEntityId: news.$id,
          relatedEntityType: "news",
        },
      });
    } catch (notificationError) {
      notificationErrors.push({
        userId: user.$id,
        email: user.email,
        message: notificationError?.message || String(notificationError),
      });
    }
  }

  await createAdminLog(databases, config, {
    adminUserId: adminUser.$id,
    actionType: "publish_news",
    targetEntityId: news.$id,
    description: `Администратор опубликовал новость "${safeTitle}"`,
  });

  return {
    news,
    notificationErrors,
  };
}

async function actionListNews({ databases, config }) {
  const result = await databases.listDocuments({
    databaseId: config.dbId,
    collectionId: config.appNewsColId,
    queries: [
      Query.orderDesc("$createdAt"),
      Query.limit(100),
    ],
  });

  return {
    news: result.documents || [],
  };
}

async function actionListAdminLogs({ databases, config }) {
  const result = await databases.listDocuments({
    databaseId: config.dbId,
    collectionId: config.adminLogsColId,
    queries: [
      Query.orderDesc("$createdAt"),
      Query.limit(100),
    ],
  });

  return {
    logs: result.documents || [],
  };
}

export default async ({ req, res, log, error }) => {
  try {
    const { users, databases } = createAppwriteClient();
    const config = getConfig();

    const body = getBody(req);
    const action = body.action;
    const payload = body.payload || {};

    if (!action) {
      return res.json(
        {
          success: false,
          message: "Не передан action",
        },
        400
      );
    }

    const adminUser = await requireAdmin(req, users);

    log(`Admin action: ${action}`);
    log(`Admin user: ${adminUser.$id}`);

    let data;

    if (action === "getMeAdminStatus") {
      data = await actionGetMeAdminStatus({ adminUser });
    } else if (action === "listUsers") {
      data = await actionListUsers({ users, databases, config, payload });
    } else if (action === "getDashboardStats") {
      data = await actionGetDashboardStats({
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "updateUserProfile") {
      data = await actionUpdateUserProfile({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "blockUser") {
      data = await actionBlockUser({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "unblockUser") {
      data = await actionUnblockUser({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "listSupportTickets") {
      data = await actionListSupportTickets({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "replySupportTicket") {
      data = await actionReplySupportTicket({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "closeSupportTicket") {
      data = await actionCloseSupportTicket({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "listNews") {
      data = await actionListNews({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "publishNews") {
      data = await actionPublishNews({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else if (action === "listAdminLogs") {
      data = await actionListAdminLogs({
        adminUser,
        users,
        databases,
        config,
        payload,
      });
    } else {
      return res.json(
        {
          success: false,
          message: `Неизвестное действие: ${action}`,
        },
        400
      );
    }

    return res.json({
      success: true,
      action,
      data,
    });
  }   } catch (err) {
    const statusCode = err?.statusCode || err?.code || 500;

    const errorDetails = {
      message: err?.message || String(err),
      code: err?.code || null,
      type: err?.type || null,
      response: err?.response || null,
      stack: err?.stack || null,
    };

    error(JSON.stringify(errorDetails, null, 2));

    return res.json(
      {
        success: false,
        message: err?.message || "Ошибка выполнения admin_api",
        details: errorDetails,
      },
      statusCode
    );
  }
