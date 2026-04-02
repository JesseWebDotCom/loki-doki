import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import EditorSidebar from '@/character-editor/components/EditorSidebar';
import CharacterWorkspace from '@/character-editor/integration/CharacterWorkspace';
import CharacterEditorWorkbench from '@/character-editor/integration/CharacterEditorWorkbench';
import { useCharacter } from '@/character-editor/context/CharacterContext';

type EditorRouteOverrides = {
  name?: string;
  identity_key?: string;
  description?: string;
  persona_prompt?: string;
  voice_model?: string;
  style?: string;
};

function buildOverrides(params: URLSearchParams): EditorRouteOverrides {
  const next: EditorRouteOverrides = {};
  for (const key of ['name', 'identity_key', 'description', 'persona_prompt', 'voice_model', 'style'] as const) {
    const value = params.get(key)?.trim();
    if (value) {
      next[key] = value;
    }
  }
  return next;
}

export default function EditorRoute() {
  const [searchParams] = useSearchParams();
  const { setOptions } = useCharacter();
  const appliedParamsRef = useRef('');
  const embedded = searchParams.get('embedded') === '1';
  const overrides = useMemo(() => buildOverrides(searchParams), [searchParams]);
  const serializedOverrides = JSON.stringify(overrides);

  useEffect(() => {
    if (!serializedOverrides || serializedOverrides === '{}' || appliedParamsRef.current === serializedOverrides) {
      return;
    }
    appliedParamsRef.current = serializedOverrides;
    setOptions((current) => ({
      ...current,
      ...overrides,
    }));
  }, [overrides, serializedOverrides, setOptions]);

  return (
    <CharacterWorkspace
      showReservedNav={!embedded}
      sidebar={embedded ? <EditorSidebar embedded /> : undefined}
    >
      <CharacterEditorWorkbench />
    </CharacterWorkspace>
  );
}
