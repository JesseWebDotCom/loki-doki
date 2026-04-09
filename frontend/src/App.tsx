import React, { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './components/theme/ThemeProvider';
import ChatPage from './pages/ChatPage';
import { AuthProvider } from './auth/AuthProvider';
import { BootstrapGate } from './components/BootstrapGate';

// Lazy-loaded pages — keeps the initial bundle small (ChatPage is the
// landing page so it stays eager).
const MemoryPage = lazy(() => import('./pages/MemoryPage'));
const PeoplePage = lazy(() => import('./pages/PeoplePage'));
const WizardPage = lazy(() => import('./pages/WizardPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const SettingsPage = lazy(() =>
  import('./admin-panel/AdminPanelPage').then(m => ({ default: m.SettingsPage }))
);
const AdminPage = lazy(() =>
  import('./admin-panel/AdminPanelPage').then(m => ({ default: m.AdminPage }))
);
const DevToolsPage = lazy(() =>
  import('./admin-panel/AdminPanelPage').then(m => ({ default: m.DevToolsPage }))
);

const App: React.FC = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="lokidoki-theme">
      <Router>
        <AuthProvider>
          <BootstrapGate>
            <Suspense fallback={null}>
              <Routes>
                <Route path="/" element={<ChatPage />} />
                <Route path="/memory" element={<MemoryPage />} />
                <Route path="/people" element={<PeoplePage />} />
                <Route path="/wizard" element={<WizardPage />} />
                <Route path="/login" element={<LoginPage />} />

                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/:section" element={<SettingsPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="/admin/:section" element={<AdminPage />} />
                <Route path="/dev" element={<DevToolsPage />} />
                <Route path="/dev/:section" element={<DevToolsPage />} />

                {/* Legacy redirect from earlier merged layout */}
                <Route path="/admin-panel" element={<Navigate to="/settings" replace />} />
                <Route path="/admin-panel/:section" element={<Navigate to="/settings" replace />} />
              </Routes>
            </Suspense>
          </BootstrapGate>
        </AuthProvider>
      </Router>
    </ThemeProvider>
  );
};

export default App;
