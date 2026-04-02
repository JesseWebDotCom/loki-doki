import { BrowserRouter, Route, Routes } from 'react-router-dom';

import FullscreenKiosk from '@/character-editor/components/FullscreenKiosk';
import CharacterRuntimeProviders from '@/character-editor/integration/CharacterRuntimeProviders';
import EditorRoute from '@/character-editor/lab/EditorRoute';
import LabHome from '@/character-editor/lab/LabHome';

export default function LabApp() {
  const basename =
    typeof window !== 'undefined' && window.location.pathname.startsWith('/character-editor')
      ? '/character-editor'
      : undefined;

  return (
    <CharacterRuntimeProviders>
      <BrowserRouter basename={basename}>
        <Routes>
          <Route path="/" element={<LabHome />} />
          <Route path="/editor" element={<EditorRoute />} />
          <Route path="/fullscreen" element={<FullscreenKiosk />} />
        </Routes>
      </BrowserRouter>
    </CharacterRuntimeProviders>
  );
}
