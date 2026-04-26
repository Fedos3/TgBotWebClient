import type {
  ApiChat,
  ApiChatFullInfo,
  ApiFormattedText,
  ApiMessage,
  ApiOnProgress,
  ApiUpdate,
  ApiUser,
  ApiUserFullInfo,
  OnApiUpdate,
} from '../../types';
import type { ThreadReadState } from '../../../types';

import { ApiMediaFormat, MAIN_THREAD_ID } from '../../types';

type BackendBot = {
  id: number;
  slot?: string;
  label?: string;
  username?: string;
  firstName?: string;
  photo_file_id?: string | null;
};

export type BotPanelBot = BackendBot;

type BackendBotsPayload = {
  defaultBotId?: string | number;
  bots?: BackendBot[];
  maxBots?: number;
  canAddMore?: boolean;
  bot?: BackendBot;
};

type BackendChatRow = {
  id: number;
  type: string;
  title?: string | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  photo_file_id?: string | null;
  last_message_id?: number | null;
  last_message_date?: number | null;
  last_message_text?: string | null;
  unread_count?: number | null;
  updated_at?: number | null;
};

type BackendMessageRow = {
  id: number;
  chat_id: number;
  date: number;
  from_id?: number | null;
  from_name?: string | null;
  is_outgoing: number;
  text?: string | null;
  media_type?: string | null;
  media_file_id?: string | null;
  media_meta?: string | null;
  reply_to_id?: number | null;
  reply_markup?: string | null;
};

type BackendMessageEvent = {
  type: 'message' | 'messageEdited';
  botId: string;
  chatId: number;
  chat?: BackendChatRow;
  message: BackendMessageRow;
};

let onUpdate: OnApiUpdate | undefined;
let currentUser: ApiUser | undefined;
let currentUserFullInfo: ApiUserFullInfo | undefined;
let eventSource: EventSource | undefined;
let availableBots: BotPanelBot[] = [];
let botsLoadedPromise: Promise<BotPanelBot[]> | undefined;
let maxBots = 5;
let canAddMoreBots = true;
let isBotConnectionPending = false;

const emptyUserStatus = { type: 'userStatusRecently' } as const;
const ACTIVE_BOT_STORAGE_KEY = 'tt-bot-panel-active-bot-id';
const BOTS_EVENT_NAME = 'tt-bot-panel-bots-updated';

export function getStoredActiveBotId() {
  return window.localStorage.getItem(ACTIVE_BOT_STORAGE_KEY) || undefined;
}

export function setStoredActiveBotId(botId: string) {
  window.localStorage.setItem(ACTIVE_BOT_STORAGE_KEY, botId);
}

function emitBotsUpdated() {
  window.dispatchEvent(new CustomEvent(BOTS_EVENT_NAME, {
    detail: {
      bots: availableBots,
      maxBots,
      canAddMore: canAddMoreBots,
    },
  }));
}

export function subscribeBotPanelBots(listener: (payload: {
  bots: BotPanelBot[];
  maxBots: number;
  canAddMore: boolean;
}) => void) {
  const handler = ((event: Event) => {
    listener((event as CustomEvent<{
      bots: BotPanelBot[];
      maxBots: number;
      canAddMore: boolean;
    }>).detail || {
      bots: [],
      maxBots: 5,
      canAddMore: true,
    });
  }) as EventListener;

  window.addEventListener(BOTS_EVENT_NAME, handler);
  return () => window.removeEventListener(BOTS_EVENT_NAME, handler);
}

export function getCachedBotPanelBots() {
  return availableBots;
}

export function getCachedBotPanelMeta() {
  return {
    bots: availableBots,
    maxBots,
    canAddMore: canAddMoreBots,
    isBotConnectionPending,
  };
}

function getActiveBotId() {
  const storedBotId = getStoredActiveBotId();
  const fallbackBotId = availableBots[0] ? String(availableBots[0].id) : undefined;
  return storedBotId || fallbackBotId;
}

function parseMediaMeta(raw?: string | null) {
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function getStoredMediaId(rawId?: string | null) {
  if (!rawId) return undefined;
  const [, id] = rawId.split(':');
  return id || undefined;
}

async function apiFetch(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (response.status === 401) {
    if (window.location.pathname !== '/login') {
      const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
    throw new Error('UNAUTHORIZED');
  }

  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      // Ignore body parse errors.
    }
    throw new Error(message || `HTTP_${response.status}`);
  }

  return response.json();
}

function updateBotsState(data: BackendBotsPayload) {
  availableBots = (data.bots || []) as BotPanelBot[];
  maxBots = Number(data.maxBots) || 5;
  canAddMoreBots = data.canAddMore !== undefined ? Boolean(data.canAddMore) : availableBots.length < maxBots;
  isBotConnectionPending = !availableBots.length;

  const storedBotId = getStoredActiveBotId();
  const defaultBotId = String(data.defaultBotId || availableBots[0]?.id || '');
  const resolvedBotId = availableBots.some((bot) => String(bot.id) === String(storedBotId))
    ? String(storedBotId)
    : defaultBotId;

  if (resolvedBotId) {
    setStoredActiveBotId(resolvedBotId);
  }

  emitBotsUpdated();
}

export async function fetchBotPanelBots(force = false) {
  if (!force && availableBots.length) {
    return availableBots;
  }

  if (!force && botsLoadedPromise) {
    return botsLoadedPromise;
  }

  botsLoadedPromise = apiFetch('/api/bots').then((data: BackendBotsPayload) => {
    updateBotsState(data);
    return availableBots;
  }).finally(() => {
    botsLoadedPromise = undefined;
  });

  return botsLoadedPromise;
}

export async function addBotPanelBot({ token, label }: { token: string; label?: string }) {
  const data = await apiFetch('/api/bots', {
    method: 'POST',
    body: JSON.stringify({ token, label }),
  }) as BackendBotsPayload;

  updateBotsState(data);
  return data.bot as BotPanelBot | undefined;
}

function appendBotId(path: string, botId?: string) {
  if (!botId) return path;

  const base = new URL(path, window.location.origin);
  base.searchParams.set('botId', botId);
  return `${base.pathname}${base.search}${base.hash}`;
}

function asText(text?: string | null): ApiFormattedText | undefined {
  if (text === undefined || text === null) return undefined;
  return { text };
}

function getPrivateTitle(row: BackendChatRow) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return name || row.username || row.title || `User ${row.id}`;
}

function mapUser(row: BackendChatRow): ApiUser | undefined {
  if (row.type !== 'private') return undefined;

  return {
    id: String(row.id),
    isMin: false,
    type: 'userTypeRegular',
    firstName: row.first_name || undefined,
    lastName: row.last_name || undefined,
    usernames: row.username ? [{ username: row.username, isActive: true }] : undefined,
    hasUsername: Boolean(row.username) || undefined,
    phoneNumber: '',
    avatarPhotoId: getStoredMediaId(row.photo_file_id),
  };
}

function mapChat(row: BackendChatRow): ApiChat {
  const type = row.type === 'private'
    ? 'chatTypePrivate'
    : row.type === 'group'
      ? 'chatTypeBasicGroup'
      : row.type === 'supergroup'
        ? 'chatTypeSuperGroup'
        : 'chatTypeChannel';

  return {
    id: String(row.id),
    type,
    title: row.type === 'private' ? getPrivateTitle(row) : (row.title || row.username || `Chat ${row.id}`),
    usernames: row.username ? [{ username: row.username, isActive: true }] : undefined,
    hasUsername: Boolean(row.username) || undefined,
    membersCount: row.type === 'private' ? 2 : undefined,
    avatarPhotoId: getStoredMediaId(row.photo_file_id),
  };
}

function mapReplyMarkup(rawMarkup?: string | null) {
  if (!rawMarkup) return undefined;

  let parsed: any;
  try {
    parsed = JSON.parse(rawMarkup);
  } catch {
    return undefined;
  }

  const rows = parsed?.rows?.map((row: any) => row.buttons?.map((button: any) => {
    switch (button.type) {
      case 'callback':
        return {
          type: 'callback',
          text: button.text || '',
          data: button.data || '',
        };
      case 'url':
        return {
          type: 'url',
          text: button.text || '',
          url: button.url || '',
        };
      case 'webview':
        return {
          type: 'simpleWebView',
          text: button.text || '',
          url: button.url || '',
        };
      case 'buy':
        return {
          type: 'buy',
          text: button.text || '',
        };
      case 'game':
        return {
          type: 'game',
          text: button.text || '',
        };
      case 'switch_inline':
        return {
          type: 'switchBotInline',
          text: button.text || '',
          query: button.query || '',
          isSamePeer: Boolean(button.sameBot) || undefined,
        };
      default:
        return {
          type: 'unsupported',
          text: button.text || '',
        };
    }
  }).filter(Boolean)).filter((row: any) => row?.length);

  if (!rows?.length) return undefined;

  return parsed.kind === 'inline'
    ? { inlineButtons: rows }
    : { keyboardButtons: rows };
}

function buildMessageText(row: BackendMessageRow) {
  if (row.text) return row.text;
  if (row.media_type) return `[${row.media_type}]`;
  return '';
}

function buildPhotoContent(row: BackendMessageRow) {
  const id = getStoredMediaId(row.media_file_id);
  if (!id) return undefined;

  const meta = parseMediaMeta(row.media_meta);
  const width = Number(meta?.w) || 1280;
  const height = Number(meta?.h) || 960;

  return {
    mediaType: 'photo' as const,
    id,
    date: row.date,
    sizes: [
      {
        type: 'm' as const,
        width: Math.max(90, Math.round(width / 2)),
        height: Math.max(90, Math.round(height / 2)),
      },
      {
        type: 'x' as const,
        width,
        height,
      },
    ],
  };
}

function buildVoiceContent(row: BackendMessageRow) {
  const id = getStoredMediaId(row.media_file_id);
  if (!id) return undefined;

  const meta = parseMediaMeta(row.media_meta);
  return {
    mediaType: 'voice' as const,
    id,
    duration: Number(meta?.duration) || 0,
    size: Number(meta?.size) || 0,
  };
}

function buildAudioContent(row: BackendMessageRow) {
  const id = getStoredMediaId(row.media_file_id);
  if (!id) return undefined;

  const meta = parseMediaMeta(row.media_meta);
  return {
    mediaType: 'audio' as const,
    id,
    size: Number(meta?.size) || 0,
    mimeType: meta?.mime || 'audio/mpeg',
    fileName: meta?.name || 'audio',
    duration: Number(meta?.duration) || 0,
  };
}

function mapMessage(row: BackendMessageRow): ApiMessage {
  const fallbackText = buildMessageText(row);
  const keyboard = mapReplyMarkup(row.reply_markup);
  const mediaContent = row.media_type === 'photo'
    ? { photo: buildPhotoContent(row) }
    : row.media_type === 'voice'
      ? { voice: buildVoiceContent(row) }
      : row.media_type === 'audio'
        ? { audio: buildAudioContent(row) }
        : {};
  const hasMediaContent = Object.values(mediaContent).some(Boolean);
  const text = row.text || (!hasMediaContent ? fallbackText : undefined);

  return {
    id: row.id,
    chatId: String(row.chat_id),
    date: row.date,
    isOutgoing: Boolean(row.is_outgoing),
    senderId: row.from_id ? String(row.from_id) : undefined,
    replyInfo: row.reply_to_id ? {
      type: 'message',
      replyToMsgId: row.reply_to_id,
    } : undefined,
    content: {
      ...mediaContent,
      ...(text ? { text: { text } } : {}),
    },
    ...(keyboard || {}),
  };
}

function mapThreadInfo(row: BackendChatRow) {
  return {
    chatId: String(row.id),
    isCommentsInfo: false as const,
    threadId: MAIN_THREAD_ID,
    lastMessageId: row.last_message_id || undefined,
  };
}

function mapThreadReadState(row: BackendChatRow): ThreadReadState {
  return {
    unreadCount: row.unread_count || 0,
    lastReadInboxMessageId: row.last_message_id || undefined,
    lastReadOutboxMessageId: row.last_message_id || undefined,
  };
}

function buildChatListData(payload: { chats: BackendChatRow[]; lastMessages?: BackendMessageRow[] }) {
  const users = payload.chats.map(mapUser).filter(Boolean) as ApiUser[];
  const chats = payload.chats.map(mapChat);
  const messages = (payload.lastMessages || []).map(mapMessage);

  return {
    chatIds: chats.map((chat) => chat.id),
    chats,
    users,
    userStatusesById: Object.fromEntries(users.map((user) => [user.id, emptyUserStatus])),
    draftsById: {},
    threadReadStatesById: Object.fromEntries(payload.chats.map((chat) => [String(chat.id), mapThreadReadState(chat)])),
    threadInfos: payload.chats.map(mapThreadInfo),
    orderedPinnedIds: undefined,
    totalChatCount: chats.length,
    messages,
    notifyExceptionById: {},
    lastMessageByChatId: Object.fromEntries(
      payload.chats
        .filter((chat) => chat.last_message_id)
        .map((chat) => [String(chat.id), Number(chat.last_message_id)]),
    ),
    nextOffsetId: undefined,
    nextOffsetPeerId: undefined,
    nextOffsetDate: undefined,
  };
}

async function loadCurrentUser() {
  await fetchBotPanelBots();
  const botId = getActiveBotId();
  if (!botId) {
    currentUser = {
      id: '0',
      isMin: false,
      isSelf: true,
      type: 'userTypeBot',
      firstName: 'Bot Panel',
      phoneNumber: '',
      botPlaceholder: 'Connect a bot',
    };
    currentUserFullInfo = {
      bio: 'Connect your first bot from the left header.',
    };

    onUpdate?.({
      '@type': 'updateCurrentUser',
      currentUser,
      currentUserFullInfo,
    });

    return currentUser;
  }

  const data = await apiFetch(appendBotId('/api/me', botId));
  const bot = data.bot as BackendBot;

  currentUser = {
    id: String(bot.id),
    isMin: false,
    isSelf: true,
    type: 'userTypeBot',
    firstName: bot.firstName || bot.username || 'Bot',
    usernames: bot.username ? [{ username: bot.username, isActive: true }] : undefined,
    hasUsername: Boolean(bot.username) || undefined,
    phoneNumber: '',
    botPlaceholder: 'Message',
    avatarPhotoId: getStoredMediaId(bot.photo_file_id),
  };
  currentUserFullInfo = {
    bio: bot.username ? `@${bot.username}` : undefined,
  };

  onUpdate?.({
    '@type': 'updateCurrentUser',
    currentUser,
    currentUserFullInfo,
  });

  return currentUser;
}

function ensureEventStream() {
  if (eventSource || !onUpdate || !getActiveBotId()) return;

  const botId = getActiveBotId();
  eventSource = new EventSource(appendBotId('/api/stream', botId), { withCredentials: true });
  eventSource.onmessage = (event) => {
    const payload = JSON.parse(event.data) as BackendMessageEvent | { type: 'chatRead'; chatId: number };

    if (payload.type === 'chatRead') {
      onUpdate?.({
        '@type': 'updateChat',
        id: String(payload.chatId),
        chat: { id: String(payload.chatId) },
        readState: { unreadCount: 0 },
      });
      return;
    }

    const messageEvent = payload as BackendMessageEvent;
    const chatId = String(messageEvent.chatId);

    if (messageEvent.chat) {
      const chat = mapChat(messageEvent.chat);
      onUpdate?.({
        '@type': 'updateChat',
        id: chatId,
        chat,
        readState: mapThreadReadState(messageEvent.chat),
      });
      onUpdate?.({
        '@type': 'updateChatListType',
        id: chatId,
        folderId: 0,
      });

      const user = mapUser(messageEvent.chat);
      if (user) {
        onUpdate?.({
          '@type': 'updateUser',
          id: user.id,
          user,
        });
      }
    }

    const message = mapMessage(messageEvent.message);
    if (messageEvent.type === 'messageEdited') {
      onUpdate?.({
        '@type': 'updateMessage',
        chatId,
        id: message.id,
        isFull: true,
        message,
      });
    } else {
      onUpdate?.({
        '@type': 'newMessage',
        chatId,
        id: message.id,
        message,
      });
    }
  };

  eventSource.onerror = () => {
    if (eventSource?.readyState === EventSource.CLOSED) {
      eventSource = undefined;
      onUpdate?.({ '@type': 'requestReconnectApi' });
    }
  };
}

export async function initBotPanelApi(update: OnApiUpdate) {
  onUpdate = update;
  update({ '@type': 'updateApiReady' });
  try {
    await fetchBotPanelBots();
    await loadCurrentUser();
  } catch (err) {
    if (err instanceof Error && err.message === 'UNAUTHORIZED') {
      return;
    }

    throw err;
  }
  update({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateReady' });
  update({ '@type': 'updateConnectionState', connectionState: 'connectionStateReady' });
  ensureEventStream();
}

async function fetchChats() {
  if (!getActiveBotId()) {
    return buildEmptyChatList();
  }

  const payload = await apiFetch(appendBotId('/api/chats?limit=200', getActiveBotId()));
  return buildChatListData(payload);
}

async function fetchMessages({ chat, offsetId, limit }: { chat: ApiChat; offsetId?: number; limit: number }) {
  if (!getActiveBotId()) {
    return {
      messages: [],
      users: [],
      chats: [],
      count: undefined,
      topics: [],
    };
  }

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (offsetId) {
    params.set('beforeId', String(offsetId));
  }

  const payload = await apiFetch(appendBotId(`/api/chats/${chat.id}/messages?${params.toString()}`, getActiveBotId()));
  const user = currentUser?.id === chat.id ? currentUser : undefined;

  return {
    messages: payload.messages.map(mapMessage),
    users: user ? [user] : [],
    chats: [],
    count: undefined,
    topics: [],
  };
}

async function fetchMessagesById({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
  if (!getActiveBotId()) {
    return [];
  }

  const payload = await apiFetch(`/api/chats/${chat.id}/messages/by-id`, {
    method: 'POST',
    body: JSON.stringify({ ids: messageIds, botId: getActiveBotId() }),
  });
  return payload.messages.map(mapMessage);
}

async function fetchFullChat(chat: ApiChat) {
  if (!getActiveBotId()) {
    return {
      fullInfo: {},
      chats: [],
      userStatusesById: {},
      membersCount: undefined,
    };
  }

  const payload = await apiFetch(appendBotId(`/api/chats/${chat.id}`, getActiveBotId()));
  const row = payload.chat as BackendChatRow;
  const fullInfo: ApiChatFullInfo = {
    about: row.username ? `@${row.username}` : undefined,
  };

  return {
    fullInfo,
    chats: [mapChat(row)],
    userStatusesById: {},
    membersCount: row.type === 'private' ? 2 : undefined,
  };
}

async function fetchFullUser({ id }: { id: string }) {
  if (currentUser?.id === id) {
    return {
      user: currentUser,
      fullInfo: currentUserFullInfo || {},
      users: [],
      chats: [],
    };
  }

  if (!getActiveBotId()) {
    return undefined;
  }

  const payload = await apiFetch(appendBotId(`/api/chats/${id}`, getActiveBotId()));
  const row = payload.chat as BackendChatRow;
  const user = mapUser(row);
  if (!user) return undefined;

  return {
    user,
    fullInfo: {
      bio: row.username ? `@${row.username}` : undefined,
    },
    users: [],
    chats: [mapChat(row)],
  };
}

async function requestChatUpdate({ chat }: { chat: ApiChat }) {
  if (!getActiveBotId()) {
    return true;
  }

  const payload = await apiFetch(appendBotId(`/api/chats/${chat.id}`, getActiveBotId()));
  const row = payload.chat as BackendChatRow;
  onUpdate?.({
    '@type': 'updateChat',
    id: String(row.id),
    chat: mapChat(row),
    readState: mapThreadReadState(row),
  });

  if (payload.lastMessage) {
    onUpdate?.({
      '@type': 'updateChatLastMessage',
      id: String(row.id),
      lastMessage: mapMessage(payload.lastMessage),
    });
  }

  return true;
}

async function fetchCurrentUserApi() {
  if (!currentUser) {
    await loadCurrentUser();
  } else {
    onUpdate?.({
      '@type': 'updateCurrentUser',
      currentUser,
      currentUserFullInfo: currentUserFullInfo || {},
    });
  }

  return currentUser;
}

async function sendMessage(params: any, _onProgress?: ApiOnProgress) {
  if (!params?.chat?.id || !getActiveBotId()) return undefined;

  const text = String(params.text || '').trim();
  if (!text) return undefined;

  await apiFetch(`/api/chats/${params.chat.id}/send`, {
    method: 'POST',
    body: JSON.stringify({ text, botId: getActiveBotId() }),
  });

  return true;
}

async function answerCallbackButton({
  chatId,
  messageId,
  data,
}: {
  chatId: string;
  messageId: number;
  data?: string;
}) {
  if (!getActiveBotId()) {
    return undefined;
  }

  const payload = await apiFetch(`/api/chats/${chatId}/callback`, {
    method: 'POST',
    body: JSON.stringify({ msgId: messageId, data, botId: getActiveBotId() }),
  });

  return payload.answer;
}

async function downloadMedia({
  url,
  mediaFormat,
  start,
  end,
  isHtmlAllowed,
}: {
  url: string;
  mediaFormat: ApiMediaFormat;
  start?: number;
  end?: number;
  isHtmlAllowed?: boolean;
}) {
  if (!getActiveBotId()) {
    return undefined;
  }

  const response = await fetch('/api/media', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      botId: getActiveBotId(),
      url,
      mediaFormat,
      start,
      end,
      isHtmlAllowed,
    }),
  });

  if (response.status === 401) {
    if (window.location.pathname !== '/login') {
      const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
    throw new Error('UNAUTHORIZED');
  }

  if (!response.ok) {
    return undefined;
  }

  const mimeType = response.headers.get('content-type') || undefined;
  const fullSizeHeader = response.headers.get('x-full-size');
  const fullSize = fullSizeHeader ? Number(fullSizeHeader) : undefined;

  if (mediaFormat === ApiMediaFormat.Progressive) {
    return {
      dataBlob: '',
      arrayBuffer: await response.arrayBuffer(),
      mimeType,
      fullSize,
    };
  }

  return {
    dataBlob: await response.blob(),
    arrayBuffer: undefined,
    mimeType,
    fullSize,
  };
}

async function requestSimpleWebView({ url }: { url: string }) {
  return url;
}

async function requestWebView({ url }: { url: string }) {
  return {
    url,
    queryId: String(Date.now()),
    isFullScreen: false,
  };
}

async function fetchUsers({ users }: { users: ApiUser[] }) {
  return {
    users,
    userStatusesById: Object.fromEntries(users.map((user) => [user.id, emptyUserStatus])),
  };
}

function buildEmptyChatList() {
  return {
    chatIds: [],
    chats: [],
    users: [],
    userStatusesById: {},
    draftsById: {},
    threadReadStatesById: {},
    threadInfos: [],
    orderedPinnedIds: undefined,
    totalChatCount: 0,
    messages: [],
    notifyExceptionById: {},
    lastMessageByChatId: {},
  };
}

export async function callBotPanelApi(fnName: string, ...args: any[]) {
  switch (fnName) {
    case 'fetchCurrentUser':
      return fetchCurrentUserApi();
    case 'fetchChats':
      return fetchChats();
    case 'fetchSavedChats':
    case 'fetchPinnedDialogs':
      return buildEmptyChatList();
    case 'fetchMessages':
      return fetchMessages(args[0]);
    case 'fetchMessagesById':
      return fetchMessagesById(args[0]);
    case 'sendMessage':
      return sendMessage(args[0], args[1]);
    case 'fetchFullChat':
      return fetchFullChat(args[0]);
    case 'fetchFullUser':
      return fetchFullUser(args[0]);
    case 'fetchUsers':
      return fetchUsers(args[0]);
    case 'requestChatUpdate':
      return requestChatUpdate(args[0]);
    case 'answerCallbackButton':
      return answerCallbackButton(args[0]);
    case 'requestSimpleWebView':
      return requestSimpleWebView(args[0]);
    case 'requestWebView':
    case 'requestMainWebView':
      return requestWebView(args[0]);
    case 'downloadMedia':
      return downloadMedia(args[0]);
    case 'fetchTopUsers':
    case 'fetchTopInlineBots':
    case 'fetchTopBotApps':
      return { ids: [] };
    case 'fetchContactList':
      return { users: [], userStatusesById: {} };
    case 'fetchNearestCountry':
      return undefined;
    case 'markMessageListRead':
    case 'abortChatRequests':
    case 'abortRequestGroup':
    case 'disconnect':
      return true;
    case 'destroy':
      eventSource?.close();
      eventSource = undefined;
      return true;
    default:
      return undefined;
  }
}
