import type { ReactNode } from 'react';

import EditorSidebar from '@/character-editor/components/EditorSidebar';
import HeaderControls from '@/character-editor/components/HeaderControls';
import Layout from '@/character-editor/components/Layout';
import PuppetStage from '@/character-editor/components/PuppetStage';

interface CharacterWorkspaceProps {
  children: ReactNode;
  headerControls?: ReactNode;
  sidebar?: ReactNode | null;
  puppetStage?: ReactNode;
  showReservedNav?: boolean;
  showHeader?: boolean;
}

export default function CharacterWorkspace({
  children,
  headerControls,
  sidebar,
  puppetStage,
  showReservedNav,
  showHeader,
}: CharacterWorkspaceProps) {
  return (
    <Layout
      headerControls={headerControls ?? <HeaderControls />}
      sidebar={sidebar === undefined ? <EditorSidebar /> : sidebar}
      puppetStage={puppetStage ?? <PuppetStage />}
      showReservedNav={showReservedNav}
      showHeader={showHeader}
    >
      {children}
    </Layout>
  );
}
