/**
 * BootstrapGate — routes the user to the right place based on auth state.
 *
 *   needsBootstrap   → /wizard
 *   no currentUser   → /login
 *   otherwise        → render children
 *
 * Lives outside <Routes> so it can imperatively navigate via react-router.
 */
import React, { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

const PUBLIC_PATHS = new Set(["/wizard", "/login"]);

export const BootstrapGate: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { currentUser, needsBootstrap, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (loading) return;
    if (needsBootstrap && location.pathname !== "/wizard") {
      navigate("/wizard", { replace: true });
      return;
    }
    if (!needsBootstrap && !currentUser && !PUBLIC_PATHS.has(location.pathname)) {
      navigate("/login", { replace: true });
      return;
    }
    if (currentUser && PUBLIC_PATHS.has(location.pathname)) {
      navigate("/", { replace: true });
    }
  }, [loading, needsBootstrap, currentUser, location.pathname, navigate]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0A0A0A] text-neutral-400">
        Loading
      </div>
    );
  }
  return <>{children}</>;
};
