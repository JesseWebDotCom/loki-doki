import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => ({
  sendChatMessage: vi.fn(),
  getSessionMessages: vi.fn(),
  getProjects: vi.fn(),
  getSessions: vi.fn(),
  listWorkspaces: vi.fn(),
  setSessionActiveWorkspace: vi.fn(),
  updateProject: vi.fn(),
  updateWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  listCharacters: vi.fn(),
  searchChats: vi.fn(),
  findInChat: vi.fn(),
}));

const ttsMocks = vi.hoisted(() => ({
  speak: vi.fn(),
  bargeIn: vi.fn(),
  resetStatusThrottle: vi.fn(),
  speakStatus: vi.fn(),
}));

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    sendChatMessage: apiMocks.sendChatMessage,
    getSessionMessages: apiMocks.getSessionMessages,
    getProjects: apiMocks.getProjects,
    getSessions: apiMocks.getSessions,
    listWorkspaces: apiMocks.listWorkspaces,
    setSessionActiveWorkspace: apiMocks.setSessionActiveWorkspace,
    updateProject: apiMocks.updateProject,
    updateWorkspace: apiMocks.updateWorkspace,
    createWorkspace: apiMocks.createWorkspace,
    deleteWorkspace: apiMocks.deleteWorkspace,
    listCharacters: apiMocks.listCharacters,
    searchChats: apiMocks.searchChats,
    findInChat: apiMocks.findInChat,
  };
});

vi.mock('../../utils/tts', () => ({
  resolveSpokenText: (envelope?: { spoken_text?: string; blocks?: Array<{ type: string; content?: string }> }) =>
    envelope?.spoken_text ??
    envelope?.blocks?.find((block) => block.type === 'summary')?.content ??
    '',
  ttsController: {
    bargeIn: ttsMocks.bargeIn,
    resetStatusThrottle: ttsMocks.resetStatusThrottle,
    speakStatus: ttsMocks.speakStatus,
  },
  useTTSState: () => ({
    speakingKey: null,
    pendingKey: null,
    speak: ttsMocks.speak,
    bargeIn: ttsMocks.bargeIn,
  }),
}));

vi.mock('../../lib/useDocumentTitle', () => ({
  useDocumentTitle: () => undefined,
}));

vi.mock('../../lib/connectivity', () => ({
  useConnectivityStatus: () => ({ backendReachable: true }),
}));

vi.mock('../../auth/useAuth', () => ({
  useAuth: () => ({ currentUser: { id: 1, username: 'jesse' } }),
}));

vi.mock('../../utils/characterMode', () => ({
  useCharacterMode: () => ['docked', vi.fn()],
}));

vi.mock('../../components/sidebar/Sidebar', () => ({
  default: ({
    onNewSession,
    onSelectSession,
    currentSessionId,
  }: {
    onNewSession: () => void;
    onSelectSession: (id: string) => void;
    currentSessionId?: string;
  }) => (
    <div data-testid="sidebar-stub">
      <button type="button" onClick={() => onNewSession()}>
        New session
      </button>
      <button type="button" onClick={() => onSelectSession('1')}>
        Session 1
      </button>
      <button type="button" onClick={() => onSelectSession('2')}>
        Session 2
      </button>
      <span data-testid="current-session">{currentSessionId ?? 'none'}</span>
    </div>
  ),
}));

vi.mock('../../components/chat/ChatWelcomeView', () => ({
  default: () => <div>Welcome view</div>,
}));

vi.mock('../../components/projects/ProjectLandingView', () => ({
  default: () => <div>Project landing</div>,
}));

vi.mock('../../components/sidebar/ProjectModal', () => ({
  default: () => null,
}));

vi.mock('../../components/chat/SourceSurface', () => ({
  default: () => null,
}));

vi.mock('../../components/chat/ComposerMenu', () => ({
  default: () => <div data-testid="composer-menu" />,
}));

vi.mock('../../components/workspace/WorkspaceEditor', () => ({
  default: () => null,
}));

vi.mock('../../components/chat/search/SearchDialog', () => ({
  default: () => null,
}));

vi.mock('../../components/character/CharacterFrame', () => ({
  default: () => null,
}));

vi.mock('../../components/character/FullscreenCharacterOverlay', () => ({
  default: () => null,
}));

import ChatPage from '../ChatPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );
}

function responseInit() {
  return {
    phase: 'response_init',
    status: 'data',
    data: {
      request_id: 'turn-1',
      mode: 'standard',
      blocks: [
        { id: 'summary', type: 'summary' },
        { id: 'sources', type: 'sources' },
      ],
    },
  };
}

function patch(delta: string, seq: number) {
  return {
    phase: 'block_patch',
    status: 'data',
    data: {
      block_id: 'summary',
      seq,
      delta,
    },
  };
}

function snapshot(content: string) {
  return {
    phase: 'response_snapshot',
    status: 'data',
    data: {
      envelope: {
        request_id: 'turn-1',
        mode: 'standard',
        status: 'complete',
        blocks: [
          {
            id: 'summary',
            type: 'summary',
            state: 'ready',
            seq: 2,
            content,
          },
          {
            id: 'sources',
            type: 'sources',
            state: 'ready',
            seq: 1,
            items: [
              {
                url: 'https://example.test/luke',
                title: 'Luke - Jedi Archives',
              },
            ],
          },
        ],
        source_surface: [
          {
            url: 'https://example.test/luke',
            title: 'Luke - Jedi Archives',
          },
        ],
        spoken_text: content,
      },
    },
  };
}

function synthesisDone(response: string) {
  return {
    phase: 'synthesis',
    status: 'done',
    data: {
      response,
      spoken_text: response,
      assistant_message_id: 42,
      sources: [
        {
          url: 'https://example.test/luke',
          title: 'Luke - Jedi Archives',
        },
      ],
      media: [],
    },
  };
}

function responseDone() {
  return {
    phase: 'response_done',
    status: 'data',
    data: {
      request_id: 'turn-1',
      status: 'complete',
    },
  };
}

beforeEach(() => {
  apiMocks.getProjects.mockResolvedValue({ projects: [] });
  apiMocks.getSessions.mockResolvedValue({
    details: [
      { id: 1, title: 'Session 1' },
      { id: 2, title: 'Session 2' },
    ],
  });
  apiMocks.listWorkspaces.mockResolvedValue({
    workspaces: [{ id: 'default', title: 'Default workspace' }],
  });
  apiMocks.listCharacters.mockResolvedValue({
    characters: [],
    active_character_id: null,
  });
  apiMocks.searchChats.mockResolvedValue({ results: [] });
  apiMocks.findInChat.mockResolvedValue({ results: [] });
  apiMocks.getSessionMessages.mockImplementation(async (sessionId: string) => ({
    session_id: Number(sessionId),
    messages: [],
  }));
  apiMocks.sendChatMessage.mockReset();
  ttsMocks.speak.mockReset();
  ttsMocks.bargeIn.mockReset();
  ttsMocks.resetStatusThrottle.mockReset();
  ttsMocks.speakStatus.mockReset();
  ttsMocks.speakStatus.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatPage streaming inline', () => {
  it('keeps a single assistant bubble in place across response_init, patches, snapshot, and done', async () => {
    let emit: ((event: Record<string, unknown>) => void) | null = null;
    let resolveSend: (() => void) | null = null;
    apiMocks.sendChatMessage.mockImplementation(
      async (_message: string, onEvent: (event: Record<string, unknown>) => void) => {
        emit = onEvent;
        await new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
      },
    );

    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/ask anything/i), {
      target: { value: 'Tell me about Luke' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(apiMocks.sendChatMessage).toHaveBeenCalledTimes(1));

    emit!(responseInit());
    await waitFor(() => {
      expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
    });

    emit!(patch('Luke', 1));
    await waitFor(() => {
      expect(screen.getByText(/^Luke$/)).toBeTruthy();
      expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
    });

    emit!(patch(' Skywalker', 2));
    await waitFor(() => {
      expect(screen.getByText(/Luke Skywalker/)).toBeTruthy();
      expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
    });

    emit!(snapshot('Luke Skywalker'));
    emit!(synthesisDone('Luke Skywalker'));
    emit!(responseDone());
    emit!(snapshot('Luke Skywalker'));
    resolveSend!();

    await waitFor(() => {
      expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
      expect(ttsMocks.speak).toHaveBeenCalledTimes(1);
    });
    expect(ttsMocks.speak).toHaveBeenCalledWith('msg-1', 'Luke Skywalker');
  });

  it('falls back to the legacy append path when no response_init arrives', async () => {
    apiMocks.sendChatMessage.mockImplementation(
      async (_message: string, onEvent: (event: Record<string, unknown>) => void) => {
        onEvent({
          phase: 'synthesis',
          status: 'done',
          data: {
            response: 'Fast lane answer',
            spoken_text: 'Fast lane answer',
            assistant_message_id: 77,
            sources: [],
            media: [],
          },
        });
        onEvent({
          phase: 'response_done',
          status: 'data',
          data: {
            request_id: 'turn-fast',
            status: 'complete',
          },
        });
      },
    );

    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/ask anything/i), {
      target: { value: 'Hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(screen.getByText(/Fast lane answer/)).toBeTruthy();
      expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
    });
    expect(ttsMocks.speak).toHaveBeenCalledTimes(1);
    expect(ttsMocks.speak).toHaveBeenCalledWith('msg-1', 'Fast lane answer');
  });

  it('renders history replay envelopes without streaming chrome', async () => {
    apiMocks.getSessionMessages.mockResolvedValue({
      session_id: 1,
      messages: [
        {
          id: 10,
          role: 'assistant',
          content: 'Persisted answer',
          created_at: '2026-04-12T12:00:00Z',
          response_envelope: {
            request_id: 'turn-history',
            mode: 'standard',
            status: 'complete',
            blocks: [
              {
                id: 'summary',
                type: 'summary',
                state: 'ready',
                seq: 1,
                content: 'Persisted answer',
              },
            ],
            source_surface: [],
          },
        },
      ],
    });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Session 1' }));

    await waitFor(() => expect(screen.getByText(/Persisted answer/)).toBeTruthy());
    expect(screen.queryByText('▍')).toBeNull();
    expect(ttsMocks.speak).not.toHaveBeenCalled();
  });

  it('drops the in-progress bubble when the user switches sessions mid-turn and reloads the completed turn from history', async () => {
    let emit: ((event: Record<string, unknown>) => void) | null = null;
    let resolveSend: (() => void) | null = null;
    let sessionOneLoads = 0;

    apiMocks.getSessionMessages.mockImplementation(async (sessionId: string) => {
      if (sessionId === '1') {
        sessionOneLoads += 1;
        if (sessionOneLoads > 1) {
          return {
            session_id: 1,
            messages: [
              {
                id: 99,
                role: 'assistant',
                content: 'Finished in Session 1',
                created_at: '2026-04-12T12:00:00Z',
                response_envelope: {
                  request_id: 'turn-1',
                  mode: 'standard',
                  status: 'complete',
                  blocks: [
                    {
                      id: 'summary',
                      type: 'summary',
                      state: 'ready',
                      seq: 1,
                      content: 'Finished in Session 1',
                    },
                  ],
                  source_surface: [],
                },
              },
            ],
          };
        }
      }
      return {
        session_id: Number(sessionId),
        messages: [],
      };
    });

    apiMocks.sendChatMessage.mockImplementation(
      async (_message: string, onEvent: (event: Record<string, unknown>) => void) => {
        emit = onEvent;
        await new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
      },
    );

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Session 1' }));
    await waitFor(() => expect(screen.getByTestId('current-session').textContent).toBe('1'));

    fireEvent.change(screen.getByPlaceholderText(/ask anything/i), {
      target: { value: 'Tell me about session bleed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(apiMocks.sendChatMessage).toHaveBeenCalledTimes(1));

    emit!(responseInit());
    emit!(patch('Working', 1));

    await waitFor(() => {
      expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Session 2' }));
    await waitFor(() => expect(screen.getByTestId('current-session').textContent).toBe('2'));

    emit!(synthesisDone('Finished in Session 1'));
    emit!(responseDone());
    resolveSend!();

    await waitFor(() => {
      expect(screen.queryByText(/Finished in Session 1/)).toBeNull();
    });
    expect(ttsMocks.speak).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Session 1' }));
    await waitFor(() => expect(screen.getByText(/Finished in Session 1/)).toBeTruthy());
  });
});
