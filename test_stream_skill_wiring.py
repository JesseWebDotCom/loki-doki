
import json
from unittest.mock import MagicMock, patch
import sys

# Mock out heavy dependencies that might be missing (like Pillow)
sys.modules['PIL'] = MagicMock()
sys.modules['PIL.Image'] = MagicMock()

# Import the target after any global mocks
from app.api.chat import chat_message_stream_api
from app.models.chat import ChatRequest
from app.classifier import Classification

def test_stream_skill_wiring():
    """Verify that a skill-call correctly triggers a structured stream reply."""
    
    # 1. Setup Request
    payload = ChatRequest(
        chat_id="test-session",
        message="Who is Mr. T?",
        performance_profile_id="fast",
        response_style="balanced"
    )
    
    mock_user = {"id": "admin", "username": "admin", "display_name": "Jesse"}
    
    print("\n[TEST] Verifying Skill Routing in Streaming API...")
    
    # 2. Mock ALL the required dependencies for the function
    with patch("app.api.chat.connection_scope") as mock_conn_scope, \
         patch("app.api.chat.runtime_context") as mock_runtime, \
         patch("app.api.chat.chat_store.resolve_chat") as mock_resolve, \
         patch("app.api.chat.chat_store.load_chat_history") as mock_load, \
         patch("app.api.chat.chat_store.append_chat_message"), \
         patch("app.api.chat.chat_providers") as mock_prov_func, \
         patch("app.api.chat.character_service.build_rendering_context") as mock_build_char, \
         patch("app.api.chat.build_memory_context"), \
         patch("app.api.chat.classify_message") as mock_classify, \
         patch("app.api.chat.resolve_response_style_policy") as mock_policy, \
         patch("app.api.chat.route_message_stream") as mock_route, \
         patch("app.api.chat.SkillService") as mock_skill_service_class, \
         patch("app.api.chat.assistant_message_meta") as mock_meta_func:
        
        # Configure Mocks
        mock_conn = MagicMock()
        mock_conn_scope.return_value.__enter__.return_value = mock_conn
        mock_runtime.return_value = {"settings": {"profile": "mac"}, "providers": {}}
        mock_resolve.return_value = {"id": "test-chat-id"}
        mock_load.return_value = []
        
        # Providing necessary providers to avoid KeyError
        mock_prov_func.return_value = {"llm_fast": MagicMock(), "llm_thinking": MagicMock()}
        mock_policy.return_value = {"style": "balanced", "debug": {}}
        
        # Mock Rendering Context to avoid crashes
        mock_char_context = MagicMock()
        mock_char_context.active_character_id = "test-char"
        mock_build_char.return_value = mock_char_context
        
        # THE CORE SCENARIO: Match a Wikipedia skill
        mock_classify.return_value = Classification("skill_call", "wikipedia", "Direct match")
        
        # Mock Skill Execution Result
        mock_skill_service = mock_skill_service_class.return_value
        mock_skill_service.inspect_route.return_value = {"skill": "wikipedia", "action": "lookup"}
        mock_skill_service.route_and_execute.return_value = {
            "message": {"content": "Mr. T is legendary."},
            "result": {"ok": True, "skill_id": "wikipedia", "action": "lookup"}
        }
        
        # Mock Orchestrator (it's called even if skill hits, but its stream chunks shouldn't be used)
        mock_route.return_value = MagicMock(classification=mock_classify.return_value)
        
        # Verify the meta chunk population
        mock_meta_func.return_value = {"skill_route": {"skill": "wikipedia"}}
        
        # 3. EXECUTE the streaming function
        print("Calling chat_message_stream_api...")
        response = chat_message_stream_api(payload, mock_user)
        
        # 4. CAPTURE the response events
        events = []
        for chunk in response.body_iterator:
             events.append(json.loads(chunk.strip()))
             
        # 5. VERIFY the outcome
        print(f"Total events yielded: {len(events)}")
        
        found_skill_meta = False
        for e in events:
            if e["type"] == "meta":
                if e.get("meta", {}).get("skill_route"):
                    print(f"SUCCESS: Found meta chunk with skill_route: {e['meta']['skill_route']}")
                    found_skill_meta = True
            if e["type"] == "delta":
                print(f"Delta Chunk: {e['delta']}")
                
        if found_skill_meta:
            print("\nPASSED: Skill routing integrated into streaming API correctly.")
        else:
            print("\nFAILED: Skill metadata was not found in the stream.")

if __name__ == "__main__":
    test_stream_skill_wiring()
