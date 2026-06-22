import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatContext } from '@/context/ChatContext'

export function useLoadConversation(id: string | undefined) {
  const navigate = useNavigate()
  const { conversationId, isGenerating, loadConversation, newConversation } = useChatContext()

  useEffect(() => {
    if (id) {
      // If conversationId already matches, this nav was triggered by us setting it after
      // a new generation completed — messages are already in state, skip the DB reload.
      if (id === conversationId) return
      loadConversation(id)
    } else if (!isGenerating) {
      // No id in the URL → fresh conversation view. Don't clobber a generation that
      // was just started from another page (e.g. typing on a project page navigates
      // here mid-stream); only reset when nothing is in flight.
      newConversation()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Only redirect when conversationId changes (new gen assigned it), not when `id`
  // changes — otherwise navigating to /chat fires this with the stale old id before
  // the first effect has a chance to call newConversation() and clear it.
  useEffect(() => {
    if (conversationId && !id) {
      navigate(`/chat/${conversationId}`, { replace: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])
}
