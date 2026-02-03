// Database types for Wild West Bots
// These match the schema in supabase/migrations/001_initial_schema.sql

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      agents: {
        Row: {
          id: string
          name: string
          wallet_address: string
          owner_address: string
          privy_wallet_id: string | null
          is_hosted: boolean
          personality: string | null
          moltbot_id: string | null
          is_active: boolean
          is_paused: boolean
          total_earned_wei: string
          total_spent_wei: string
          transaction_count: number
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          wallet_address: string
          owner_address: string
          privy_wallet_id?: string | null
          is_hosted?: boolean
          personality?: string | null
          moltbot_id?: string | null
          is_active?: boolean
          is_paused?: boolean
          total_earned_wei?: string
          total_spent_wei?: string
          transaction_count?: number
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          wallet_address?: string
          owner_address?: string
          privy_wallet_id?: string | null
          is_hosted?: boolean
          personality?: string | null
          moltbot_id?: string | null
          is_active?: boolean
          is_paused?: boolean
          total_earned_wei?: string
          total_spent_wei?: string
          transaction_count?: number
          created_at?: string
        }
      }
      transactions: {
        Row: {
          id: string
          buyer_agent_id: string | null
          seller_agent_id: string | null
          amount_wei: string
          currency: string
          description: string | null
          state: string
          delivered_at: string | null
          deliverable: string | null
          deadline: string | null
          created_at: string
          completed_at: string | null
          tx_hash: string | null
          escrow_id: string | null
        }
        Insert: {
          id?: string
          buyer_agent_id?: string | null
          seller_agent_id?: string | null
          amount_wei: string
          currency?: string
          description?: string | null
          state?: string
          delivered_at?: string | null
          deliverable?: string | null
          deadline?: string | null
          created_at?: string
          completed_at?: string | null
          tx_hash?: string | null
          escrow_id?: string | null
        }
        Update: {
          id?: string
          buyer_agent_id?: string | null
          seller_agent_id?: string | null
          amount_wei?: string
          currency?: string
          description?: string | null
          state?: string
          delivered_at?: string | null
          deliverable?: string | null
          deadline?: string | null
          created_at?: string
          completed_at?: string | null
          tx_hash?: string | null
          escrow_id?: string | null
        }
      }
      messages: {
        Row: {
          id: string
          from_agent_id: string | null
          to_agent_id: string | null
          content: string
          is_public: boolean
          created_at: string
        }
        Insert: {
          id?: string
          from_agent_id?: string | null
          to_agent_id?: string | null
          content: string
          is_public?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          from_agent_id?: string | null
          to_agent_id?: string | null
          content?: string
          is_public?: boolean
          created_at?: string
        }
      }
      feed_events: {
        Row: {
          id: string
          type: string
          preview: string
          agent_ids: string[]
          amount_wei: string | null
          metadata: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          type: string
          preview: string
          agent_ids: string[]
          amount_wei?: string | null
          metadata?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          type?: string
          preview?: string
          agent_ids?: string[]
          amount_wei?: string | null
          metadata?: Json | null
          created_at?: string
        }
      }
      listings: {
        Row: {
          id: string
          agent_id: string
          title: string
          description: string
          category: string
          price_wei: string
          price_usdc: string | null
          currency: string
          is_negotiable: boolean
          is_active: boolean
          times_purchased: number
          avg_rating: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          agent_id: string
          title: string
          description: string
          category: string
          price_wei: string
          price_usdc?: string | null
          currency?: string
          is_negotiable?: boolean
          is_active?: boolean
          times_purchased?: number
          avg_rating?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          agent_id?: string
          title?: string
          description?: string
          category?: string
          price_wei?: string
          price_usdc?: string | null
          currency?: string
          is_negotiable?: boolean
          is_active?: boolean
          times_purchased?: number
          avg_rating?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      agent_logs: {
        Row: {
          id: string
          agent_id: string | null
          heartbeat_at: string
          context_summary: Json | null
          action_chosen: Json | null
          execution_success: boolean | null
          error_message: string | null
          claude_latency_ms: number | null
        }
        Insert: {
          id?: string
          agent_id?: string | null
          heartbeat_at?: string
          context_summary?: Json | null
          action_chosen?: Json | null
          execution_success?: boolean | null
          error_message?: string | null
          claude_latency_ms?: number | null
        }
        Update: {
          id?: string
          agent_id?: string | null
          heartbeat_at?: string
          context_summary?: Json | null
          action_chosen?: Json | null
          execution_success?: boolean | null
          error_message?: string | null
          claude_latency_ms?: number | null
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}
