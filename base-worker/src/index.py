"""
Turing Base Worker - Entry Point
Ephemeral container that runs a Hermes agent to process a ticket.
STRICT RULE #1: Zero-State Worker - no persistent state, container dies on exit
"""

import os
import sys
import json

# Entry point - receives TICKET_ID from Orchestrator via environment variable
TICKET_ID = os.environ.get('TICKET_ID')
ROLE = os.environ.get('ROLE', 'default')
LLM_API_KEY = os.environ.get('LLM_API_KEY')
LLM_PROVIDER = os.environ.get('LLM_PROVIDER', 'openai')  # 'openai' or 'anthropic'

if not TICKET_ID:
    print("[Worker] FATAL: TICKET_ID environment variable is required")
    sys.exit(1)

if not LLM_API_KEY:
    print("[Worker] FATAL: LLM_API_KEY environment variable is required")
    sys.exit(1)

print(f"[Worker] Starting for ticket: {TICKET_ID}, role: {ROLE}, provider: {LLM_PROVIDER}")

def create_agent():
    """Factory function to create the appropriate agent based on LLM_PROVIDER"""
    from agent.hermes_loop import HermesAgent, OpenAIAgent, AnthropicAgent
    
    # Create base agent with tools
    if LLM_PROVIDER == 'anthropic':
        agent = AnthropicAgent(ticket_id=TICKET_ID, role=ROLE, api_key=LLM_API_KEY)
    else:
        # Default to OpenAI
        agent = OpenAIAgent(ticket_id=TICKET_ID, role=ROLE, api_key=LLM_API_KEY)
    
    return agent

def main():
    """Main entry point"""
    try:
        # Create agent with LLM integration
        agent = create_agent()
        
        # Get task details from ticket
        print("[Worker] Reading ticket information...")
        from tools import plane_tools
        ticket = plane_tools.read_ticket(TICKET_ID)
        
        task_description = ticket.get('description', '') or ticket.get('title', 'No task description')
        print(f"[Worker] Task: {task_description[:200]}...")
        
        # Run the agent
        result = agent.run(initial_task=task_description)
        
        print(f"[Worker] Agent finished with result: {result}")
        
        # Update ticket status based on result
        if result == 'done':
            print(f"[Worker] Task completed successfully")
            # Status already updated by agent via update_ticket_status tool
        elif result == 'blocked':
            print(f"[Worker] Task is blocked, waiting for human intervention")
            plane_tools.update_ticket_status(TICKET_ID, 'BLOCKED', 'Task blocked - awaiting human intervention')
        else:
            print(f"[Worker] Task did not complete normally: {result}")
            
        print(f"[Worker] Exiting for ticket {TICKET_ID}")
        sys.exit(0)
        
    except Exception as e:
        print(f"[Worker] FATAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        
        # Try to mark ticket as blocked
        try:
            from tools import plane_tools
            plane_tools.update_ticket_status(TICKET_ID, 'BLOCKED', f'Worker error: {str(e)}')
        except:
            pass
            
        sys.exit(1)

if __name__ == "__main__":
    main()