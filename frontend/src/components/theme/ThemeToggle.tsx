import React from "react"
import { Moon, Sun, Monitor } from "lucide-react"
import { useTheme } from "./ThemeProvider"

const ThemeToggle: React.FC = () => {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex bg-[#131416] p-1.5 rounded-2xl border border-gray-800/50 shadow-m2">
      <button
        onClick={() => setTheme("light")}
        className={`p-2 rounded-xl transition-all ${
          theme === "light" 
            ? "bg-primary text-white shadow-m1" 
            : "text-gray-500 hover:text-gray-300"
        }`}
        title="Day Mode"
      >
        <Sun size={18} />
      </button>
      <button
        onClick={() => setTheme("dark")}
        className={`p-2 rounded-xl transition-all ${
          theme === "dark" 
            ? "bg-primary text-white shadow-m1" 
            : "text-gray-500 hover:text-gray-300"
        }`}
        title="Night Mode"
      >
        <Moon size={18} />
      </button>
      <button
        onClick={() => setTheme("system")}
        className={`p-2 rounded-xl transition-all ${
          theme === "system" 
            ? "bg-primary text-white shadow-m1" 
            : "text-gray-500 hover:text-gray-300"
        }`}
        title="System Sync"
      >
        <Monitor size={18} />
      </button>
    </div>
  )
}

export default ThemeToggle
