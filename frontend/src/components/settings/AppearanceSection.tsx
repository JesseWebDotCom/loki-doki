import React from "react";
import ThemeCustomizer from "../theme/ThemeCustomizer";
import ThemeShowcase from "../theme/ThemeShowcase";

const AppearanceSection: React.FC = () => (
  <div className="relative rounded-[1.75rem] border border-border/20 bg-onyx-2/5 shadow-m4 overflow-hidden min-h-[42rem]">
    <ThemeShowcase />
    <ThemeCustomizer />
  </div>
);

export default AppearanceSection;
