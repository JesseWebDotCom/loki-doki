import React from "react"
import ReactDOM from "react-dom/client"

import App from "./App"
import CharacterEditorApp from "./character-editor/CharacterEditorApp"
import "./index.css"

const isCharacterEditorRoute =
  typeof window !== "undefined" && window.location.pathname.startsWith("/character-editor")

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isCharacterEditorRoute ? <CharacterEditorApp /> : <App />}
  </React.StrictMode>
)
