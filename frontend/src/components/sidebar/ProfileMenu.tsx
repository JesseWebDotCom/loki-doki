import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings, ShieldCheck, Wrench, LogOut, ChevronUp, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { useAuth } from '../../auth/useAuth';

interface ProfileMenuProps {
  /** Render only the avatar button (for collapsed sidebar rail). */
  compact?: boolean;
}

const ProfileMenu: React.FC<ProfileMenuProps> = ({ compact = false }) => {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();

  const username = currentUser?.username ?? 'Guest';
  const role = currentUser?.role ?? 'user';
  const initial = username.charAt(0).toUpperCase();
  const isAdmin = role === 'admin';
  const profileImage = currentUser?.profile_image_url;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            className="w-8 h-8 flex items-center justify-center rounded-md text-primary hover:bg-card/50 transition-colors focus:outline-none cursor-pointer"
            aria-label="Open profile menu"
            title={username}
          >
            {profileImage ? (
              <img src={profileImage} alt={username} className="w-5 h-5 rounded-md object-cover border border-primary/20" />
            ) : (
              <span className="w-5 h-5 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center font-bold text-[10px]">
                {currentUser ? initial : <User size={10} />}
              </span>
            )}
          </button>
        ) : (
        <button
          className="w-full flex items-center rounded-md hover:bg-card/50 transition-colors group focus:outline-none cursor-pointer"
          aria-label="Open profile menu"
        >
          <span className="w-8 h-8 flex items-center justify-center text-primary shrink-0">
            {profileImage ? (
              <img src={profileImage} alt={username} className="w-5 h-5 rounded-md object-cover border border-primary/20" />
            ) : (
              <span className="w-5 h-5 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center font-bold text-[10px]">
                {currentUser ? initial : <User size={10} />}
              </span>
            )}
          </span>
          <span className="flex-1 ml-1 text-left min-w-0 text-xs font-medium text-sidebar-foreground truncate">
            {username}
          </span>
          <ChevronUp size={12} className="mr-2 text-muted-foreground group-hover:text-foreground transition-colors" />
        </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel>Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings size={16} />
          <span>Settings</span>
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem onSelect={() => navigate('/admin')}>
            <ShieldCheck size={16} />
            <span>Admin Panel</span>
          </DropdownMenuItem>
        )}
        {isAdmin && (
          <DropdownMenuItem onSelect={() => navigate('/dev')}>
            <Wrench size={16} />
            <span>Dev Tools</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/people')}>
          <User size={16} />
          <span>People</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleLogout} className="focus:bg-destructive/10 focus:text-destructive">
          <LogOut size={16} />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ProfileMenu;
