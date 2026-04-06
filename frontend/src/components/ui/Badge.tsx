import React from 'react';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'outline' | 'success' | 'warning';
  className?: string;
}

const Badge: React.FC<BadgeProps> = ({ children, variant = 'default', className = '' }) => {
  const base = "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest inline-flex items-center justify-center";
  const variants = {
    default: "bg-electric/10 text-electric border border-electric/20",
    outline: "border border-gray-700 text-gray-500",
    success: "bg-green-500/10 text-green-500 border border-green-500/20",
    warning: "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"
  };

  return (
    <span className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </span>
  );
};

export default Badge;
