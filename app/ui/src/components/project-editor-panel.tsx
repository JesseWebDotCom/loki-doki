import { useState, useRef, useEffect } from "react"
import * as LucideIcons from "lucide-react"
import { 
  Folder, Save, X, Briefcase, Book, Code, Terminal, MessageSquare, 
  Laptop, Globe, Cpu, Database, Cloud, FileText, Image, Video, 
  Music, Headphones, Settings, User, Users, Lock, Unlock, 
  Key, Hammer, PenTool, Hash, Info, Lightbulb, Zap, Rocket, 
  Star, Heart, Search, ChevronDown, ChevronUp, Pipette
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export type Project = {
  id?: string
  name: string
  description: string
  instructions: string
  icon: string
  icon_color: string
}

type ProjectEditorPanelProps = {
  project?: Project | null
  onSave: (project: Project) => void
  onCancel: () => void
}

const COMMON_ICONS = [
  "Folder", "Briefcase", "Book", "Code", "Terminal", "MessageSquare", 
  "Laptop", "Globe", "Cpu", "Database", "Cloud", "FileText", "Image", 
  "Video", "Music", "Headphones", "Settings", "User", "Users", "Lock", 
  "Unlock", "Key", "Hammer", "PenTool", "Hash", "Info", "Lightbulb", 
  "Zap", "Rocket", "Star", "Heart"
]

const PRESET_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', 
  '#ec4899', '#6366f1', '#14b8a6', '#f97316', '#a855f7',
  '#2dd4bf', '#84cc16', '#fbbf24', '#f87171', '#60a5fa',
  '#a78bfa', '#f472b6', '#fb923c', '#4ade80', '#94a3b8'
]

export function ProjectEditorPanel({ project, onSave, onCancel }: ProjectEditorPanelProps) {
  const [name, setName] = useState(project?.name || "")
  const [description, setDescription] = useState(project?.description || "")
  const [instructions, setInstructions] = useState(project?.instructions || "")
  const [icon, setIcon] = useState(project?.icon || "Folder")
  const [iconColor, setIconColor] = useState(project?.icon_color || "#3b82f6")
  
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [iconSearch, setIconSearch] = useState("")

  const iconPickerRef = useRef<HTMLDivElement>(null)
  const colorPickerRef = useRef<HTMLDivElement>(null)
  const customColorInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (iconPickerRef.current && !iconPickerRef.current.contains(event.target as Node)) {
        setShowIconPicker(false)
      }
      if (colorPickerRef.current && !colorPickerRef.current.contains(event.target as Node)) {
        setShowColorPicker(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      id: project?.id,
      name,
      description,
      instructions,
      icon,
      icon_color: iconColor,
    })
  }

  const IconComponent = (LucideIcons as any)[icon] || LucideIcons.Folder

  const filteredIcons = COMMON_ICONS.filter(name => 
    name.toLowerCase().includes(iconSearch.toLowerCase())
  )

  return (
    <Card className="border-[var(--line)] bg-[var(--card)]/98 text-[var(--foreground)] shadow-2xl relative z-50">
      <CardContent className="p-6">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--muted-foreground)] opacity-80">New Workspace</div>
            <h1 className="mt-1 text-2xl font-bold text-[var(--foreground)]">
              {project?.id ? "Edit Project" : "Create Project"}
            </h1>
          </div>
          <Button 
            className="h-8 w-8 rounded-full border border-[var(--line)] bg-[var(--panel)] p-0 text-[var(--muted-foreground)] hover:bg-[var(--input)] hover:text-[var(--foreground)]" 
            onClick={onCancel} 
            type="button" 
            variant="ghost"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">Project Name</label>
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Novel Writing, Code Architecture..."
                className="border-[var(--line)] bg-[var(--input)] text-[var(--foreground)]"
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">Description</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this project's goals"
                className="border-[var(--line)] bg-[var(--input)] text-[var(--foreground)]"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">Custom Instructions (System Prompt)</label>
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Set specific rules, tone, or context for chats inside this project..."
                className="min-h-[140px] border-[var(--line)] bg-[var(--input)] text-[var(--foreground)]"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2 relative" ref={iconPickerRef}>
                <label className="text-sm font-medium text-[var(--foreground)]">Icon</label>
                <div 
                  onClick={() => setShowIconPicker(!showIconPicker)}
                  className="flex items-center gap-3 p-2 rounded-md border border-[var(--line)] bg-[var(--input)] hover:bg-[var(--input)]/80 cursor-pointer transition-colors"
                >
                  <div className="p-2 rounded bg-[var(--panel)] border border-[var(--line)]" style={{ color: iconColor }}>
                    <IconComponent className="h-4 w-4" />
                  </div>
                  <span className="flex-1 text-sm text-[var(--foreground)]">{icon}</span>
                  {showIconPicker ? (
                    <ChevronUp className="h-4 w-4 text-[var(--muted-foreground)]" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-[var(--muted-foreground)]" />
                  )}
                </div>
                
                {showIconPicker && (
                  <div className="absolute bottom-full left-0 mb-2 w-72 bg-[var(--card)] border border-[var(--line)] rounded-lg shadow-2xl p-3 z-[60] overflow-hidden">
                    <div className="relative mb-3">
                      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-[var(--muted-foreground)]" />
                      <Input
                        value={iconSearch}
                        onChange={(e) => setIconSearch(e.target.value)}
                        placeholder="Search icons..."
                        className="pl-8 h-9 text-xs border-[var(--line)] bg-[var(--input)]"
                        autoFocus
                      />
                    </div>
                    <div className="grid grid-cols-6 gap-1 max-h-[220px] overflow-y-auto pr-1">
                      {filteredIcons.map((iconName) => {
                        const Icon = (LucideIcons as any)[iconName]
                        return (
                          <button
                            key={iconName}
                            type="button"
                            onClick={() => {
                              setIcon(iconName)
                              setShowIconPicker(false)
                            }}
                            className={`p-2 rounded-md flex items-center justify-center transition-colors ${icon === iconName ? 'bg-[var(--accent)] text-[var(--accent-foreground)]' : 'hover:bg-[var(--input)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'}`}
                            title={iconName}
                          >
                            <Icon className="h-4 w-4" />
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2 relative" ref={colorPickerRef}>
                <label className="text-sm font-medium text-[var(--foreground)]">Icon Color</label>
                <div className="flex gap-2 items-center">
                  <div 
                    onClick={() => setShowColorPicker(!showColorPicker)}
                    className="h-10 w-14 rounded-md cursor-pointer border border-[var(--line)] overflow-hidden shadow-sm hover:ring-2 ring-[var(--accent)] transition-all"
                    style={{ backgroundColor: iconColor }}
                  />
                  <Input
                    value={iconColor}
                    onChange={(e) => setIconColor(e.target.value)}
                    placeholder="#000000"
                    className="flex-1 border-[var(--line)] bg-[var(--input)] text-[var(--foreground)] uppercase font-mono"
                  />
                </div>
                
                {showColorPicker && (
                  <div className="absolute bottom-full right-0 mb-2 p-3 bg-[var(--card)] border border-[var(--line)] rounded-lg shadow-2xl z-[60] w-[200px]">
                    <div className="text-[10px] uppercase font-bold text-[var(--muted-foreground)] mb-2 px-1">Presets</div>
                    <div className="grid grid-cols-5 gap-2 mb-3">
                      {PRESET_COLORS.map(color => (
                        <button
                          key={color}
                          type="button"
                          className={`h-6 w-6 rounded-full border border-black/10 transition-transform hover:scale-110 active:scale-95 ${iconColor.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--card)]' : ''}`}
                          style={{ backgroundColor: color }}
                          onClick={() => setIconColor(color)}
                        />
                      ))}
                    </div>
                    
                    <div className="pt-2 border-t border-[var(--line)]">
                      <label className="relative w-full flex items-center justify-center gap-2 py-1.5 rounded bg-[var(--input)] hover:bg-[var(--line)] text-[11px] text-[var(--foreground)] transition-colors cursor-pointer">
                        <Pipette className="h-3 w-3" />
                        Custom Color
                        <input
                          ref={customColorInputRef}
                          type="color"
                          value={iconColor}
                          onChange={(e) => setIconColor(e.target.value)}
                          className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-4 flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={onCancel} className="text-[var(--foreground)] hover:bg-[var(--input)]">
                Cancel
              </Button>
              <Button type="submit" className="bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent)]/90">
                <Save className="mr-2 h-4 w-4" />
                Save Project
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
  )
}