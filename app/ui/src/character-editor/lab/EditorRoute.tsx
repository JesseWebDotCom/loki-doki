import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import CharacterWorkspace from '@/character-editor/integration/CharacterWorkspace';
import CharacterEditorWorkbench from '@/character-editor/integration/CharacterEditorWorkbench';
import { useCharacter } from '@/character-editor/context/CharacterContext';

type EditorRouteOverrides = {
  character_id?: string;
  name?: string;
  identity_key?: string;
  description?: string;
  teaser?: string;
  phonetic_spelling?: string;
  persona_prompt?: string;
  preferred_response_style?: string;
  voice_model?: string;
  style?: string;
};

function buildOverrides(params: URLSearchParams): EditorRouteOverrides {
  const next: EditorRouteOverrides = {};
  for (const key of ['character_id', 'name', 'identity_key', 'description', 'teaser', 'phonetic_spelling', 'persona_prompt', 'preferred_response_style', 'voice_model', 'style'] as const) {
    const value = params.get(key)?.trim();
    if (value) {
      next[key] = value;
    }
  }
  return next;
}

function parseEditorState(params: URLSearchParams) {
  const raw = params.get('editor_state')?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    console.warn('Invalid editor_state payload ignored.', error);
  }
  return null;
}

export default function EditorRoute() {
  const [searchParams] = useSearchParams();
  const { setOptions } = useCharacter();
  const appliedParamsRef = useRef('');
  const embedded = searchParams.get('embedded') === '1';
  const overrides = useMemo(() => buildOverrides(searchParams), [searchParams]);
  const editorState = useMemo(() => parseEditorState(searchParams), [searchParams]);
  const serializedOverrides = JSON.stringify({ editorState, overrides });

  useEffect(() => {
    if (!serializedOverrides || serializedOverrides === '{}' || appliedParamsRef.current === serializedOverrides) {
      return;
    }
    appliedParamsRef.current = serializedOverrides;
    setOptions((current) => ({
      ...current,
      ...(editorState || {}),
      ...overrides,
    }));
  }, [editorState, overrides, serializedOverrides, setOptions]);

  return (
    <CharacterWorkspace
      showReservedNav={!embedded}
      sidebar={embedded ? null : undefined}
    >
      <CharacterEditorWorkbench />
    </CharacterWorkspace>
  );
}
