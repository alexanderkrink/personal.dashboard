export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_generations: {
        Row: {
          attempt: number
          cache_read_tokens: number
          cache_write_tokens: number
          cost_usd: number | null
          created_at: string
          error_message: string | null
          id: string
          input_hash: string
          input_tokens: number
          job: string
          latency_ms: number
          model: string
          outcome: string
          output_tokens: number
          prompt_id: string
          prompt_version: number
          provider: string
          raw_text: string | null
          step: string
          user_id: string
        }
        Insert: {
          attempt: number
          cache_read_tokens?: number
          cache_write_tokens?: number
          cost_usd?: number | null
          created_at?: string
          error_message?: string | null
          id?: string
          input_hash: string
          input_tokens?: number
          job: string
          latency_ms: number
          model: string
          outcome: string
          output_tokens?: number
          prompt_id: string
          prompt_version: number
          provider: string
          raw_text?: string | null
          step: string
          user_id: string
        }
        Update: {
          attempt?: number
          cache_read_tokens?: number
          cache_write_tokens?: number
          cost_usd?: number | null
          created_at?: string
          error_message?: string | null
          id?: string
          input_hash?: string
          input_tokens?: number
          job?: string
          latency_ms?: number
          model?: string
          outcome?: string
          output_tokens?: number
          prompt_id?: string
          prompt_version?: number
          provider?: string
          raw_text?: string | null
          step?: string
          user_id?: string
        }
        Relationships: []
      }
      assessments: {
        Row: {
          confirmed: boolean
          course_id: string
          created_at: string
          due_hint: string | null
          id: string
          kind: string
          session_number: number | null
          source: string
          title: string
          updated_at: string
          user_id: string
          weight_percent: number
        }
        Insert: {
          confirmed?: boolean
          course_id: string
          created_at?: string
          due_hint?: string | null
          id?: string
          kind: string
          session_number?: number | null
          source?: string
          title: string
          updated_at?: string
          user_id: string
          weight_percent: number
        }
        Update: {
          confirmed?: boolean
          course_id?: string
          created_at?: string
          due_hint?: string | null
          id?: string
          kind?: string
          session_number?: number | null
          source?: string
          title?: string
          updated_at?: string
          user_id?: string
          weight_percent?: number
        }
        Relationships: [
          {
            foreignKeyName: "assessments_course_id_fkey"
            columns: ["course_id", "user_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      calendar_feeds: {
        Row: {
          active: boolean
          config: Json
          created_at: string
          id: string
          label: string
          last_sync_error: string | null
          last_sync_status: string | null
          last_synced_at: string | null
          provider: string
          sync_cursor: Json | null
          sync_lease_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          config: Json
          created_at?: string
          id?: string
          label: string
          last_sync_error?: string | null
          last_sync_status?: string | null
          last_synced_at?: string | null
          provider?: string
          sync_cursor?: Json | null
          sync_lease_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          config?: Json
          created_at?: string
          id?: string
          label?: string
          last_sync_error?: string | null
          last_sync_status?: string | null
          last_synced_at?: string | null
          provider?: string
          sync_cursor?: Json | null
          sync_lease_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      calendar_items: {
        Row: {
          assessment_id: string | null
          course_id: string | null
          created_at: string
          description: string | null
          descriptor: string | null
          detection_source: string | null
          feed_id: string | null
          hidden: boolean
          ics_uid: string
          id: string
          is_exam_candidate: boolean
          kind: string
          location: string | null
          missing_since: string | null
          original_tzid: string | null
          raw_summary: string | null
          rrule: string | null
          sequence: number
          session_from: number | null
          session_to: number | null
          source: string
          title: string
          updated_at: string
          user_id: string
          user_locked_fields: string[]
          weight_override: number | null
        }
        Insert: {
          assessment_id?: string | null
          course_id?: string | null
          created_at?: string
          description?: string | null
          descriptor?: string | null
          detection_source?: string | null
          feed_id?: string | null
          hidden?: boolean
          ics_uid: string
          id?: string
          is_exam_candidate?: boolean
          kind: string
          location?: string | null
          missing_since?: string | null
          original_tzid?: string | null
          raw_summary?: string | null
          rrule?: string | null
          sequence?: number
          session_from?: number | null
          session_to?: number | null
          source: string
          title: string
          updated_at?: string
          user_id: string
          user_locked_fields?: string[]
          weight_override?: number | null
        }
        Update: {
          assessment_id?: string | null
          course_id?: string | null
          created_at?: string
          description?: string | null
          descriptor?: string | null
          detection_source?: string | null
          feed_id?: string | null
          hidden?: boolean
          ics_uid?: string
          id?: string
          is_exam_candidate?: boolean
          kind?: string
          location?: string | null
          missing_since?: string | null
          original_tzid?: string | null
          raw_summary?: string | null
          rrule?: string | null
          sequence?: number
          session_from?: number | null
          session_to?: number | null
          source?: string
          title?: string
          updated_at?: string
          user_id?: string
          user_locked_fields?: string[]
          weight_override?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "calendar_items_assessment_id_fkey"
            columns: ["assessment_id", "user_id"]
            isOneToOne: false
            referencedRelation: "assessments"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "calendar_items_course_id_fkey"
            columns: ["course_id", "user_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "calendar_items_feed_id_fkey"
            columns: ["feed_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_feeds"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      calendar_occurrences: {
        Row: {
          all_day: boolean
          completed_at: string | null
          ends_at: string | null
          id: string
          item_id: string
          overridden: boolean
          recurrence_id: string
          starts_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          all_day?: boolean
          completed_at?: string | null
          ends_at?: string | null
          id?: string
          item_id: string
          overridden?: boolean
          recurrence_id?: string
          starts_at: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          all_day?: boolean
          completed_at?: string | null
          ends_at?: string | null
          id?: string
          item_id?: string
          overridden?: boolean
          recurrence_id?: string
          starts_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_occurrences_item_id_fkey"
            columns: ["item_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_items"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      course_matchers: {
        Row: {
          course_id: string
          created_at: string
          id: string
          pattern: string
          user_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          pattern: string
          user_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          pattern?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_matchers_course_id_fkey"
            columns: ["course_id", "user_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      courses: {
        Row: {
          absence_fail_pct: number | null
          archived: boolean
          code: string | null
          color: string
          created_at: string
          credits: number | null
          exam_format_profile: Json | null
          grading_scale: string
          id: string
          participation_target: number | null
          participation_weight: number | null
          semester_id: string | null
          target_grade: number | null
          title: string
          total_sessions: number | null
          total_sessions_source: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          absence_fail_pct?: number | null
          archived?: boolean
          code?: string | null
          color?: string
          created_at?: string
          credits?: number | null
          exam_format_profile?: Json | null
          grading_scale?: string
          id?: string
          participation_target?: number | null
          participation_weight?: number | null
          semester_id?: string | null
          target_grade?: number | null
          title: string
          total_sessions?: number | null
          total_sessions_source?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          absence_fail_pct?: number | null
          archived?: boolean
          code?: string | null
          color?: string
          created_at?: string
          credits?: number | null
          exam_format_profile?: Json | null
          grading_scale?: string
          id?: string
          participation_target?: number | null
          participation_weight?: number | null
          semester_id?: string | null
          target_grade?: number | null
          title?: string
          total_sessions?: number | null
          total_sessions_source?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "courses_semester_id_fkey"
            columns: ["semester_id", "user_id"]
            isOneToOne: false
            referencedRelation: "semesters"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      job_heartbeats: {
        Row: {
          created_at: string
          id: string
          job: string
          run_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          job: string
          run_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          job?: string
          run_id?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          locale: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          locale?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          locale?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      semesters: {
        Row: {
          created_at: string
          ends_on: string
          id: string
          name: string
          starts_on: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          ends_on: string
          id?: string
          name: string
          starts_on: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          ends_on?: string
          id?: string
          name?: string
          starts_on?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      syllabus_extraction_components: {
        Row: {
          assessment_id: string
          created_at: string
          extraction_id: string
          id: string
          session_note: string | null
          source_snippet: string
          user_id: string
        }
        Insert: {
          assessment_id: string
          created_at?: string
          extraction_id: string
          id?: string
          session_note?: string | null
          source_snippet: string
          user_id: string
        }
        Update: {
          assessment_id?: string
          created_at?: string
          extraction_id?: string
          id?: string
          session_note?: string | null
          source_snippet?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "syllabus_extraction_components_assessment_id_fkey"
            columns: ["assessment_id", "user_id"]
            isOneToOne: false
            referencedRelation: "assessments"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "syllabus_extraction_components_extraction_id_fkey"
            columns: ["extraction_id", "user_id"]
            isOneToOne: false
            referencedRelation: "syllabus_extractions"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      syllabus_extractions: {
        Row: {
          confirmed_at: string | null
          course_id: string
          created_at: string
          extracted_course_title: string
          id: string
          input_hash: string
          model: string
          notes: string | null
          prompt_id: string
          prompt_version: number
          proposed_total_sessions: number | null
          provider: string
          source_label: string
          total_sessions_evidence: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          confirmed_at?: string | null
          course_id: string
          created_at?: string
          extracted_course_title: string
          id?: string
          input_hash: string
          model: string
          notes?: string | null
          prompt_id: string
          prompt_version: number
          proposed_total_sessions?: number | null
          provider: string
          source_label: string
          total_sessions_evidence?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          confirmed_at?: string | null
          course_id?: string
          created_at?: string
          extracted_course_title?: string
          id?: string
          input_hash?: string
          model?: string
          notes?: string | null
          prompt_id?: string
          prompt_version?: number
          proposed_total_sessions?: number | null
          provider?: string
          source_label?: string
          total_sessions_evidence?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "syllabus_extractions_course_id_fkey"
            columns: ["course_id", "user_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Views: {
      ai_daily_cost: {
        Row: {
          cache_read_tokens: number | null
          cache_write_tokens: number | null
          calls: number | null
          cost_usd: number | null
          day: string | null
          input_tokens: number | null
          model: string | null
          output_tokens: number | null
          provider: string | null
          successes: number | null
          unpriced_calls: number | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      apply_syllabus_extraction: {
        Args: {
          p_components: Json
          p_course_id: string
          p_extracted_course_title: string
          p_input_hash: string
          p_model: string
          p_notes: string
          p_prompt_id: string
          p_prompt_version: number
          p_proposed_total_sessions: number
          p_provider: string
          p_source_label: string
          p_total_sessions_evidence: string
          p_user_id: string
        }
        Returns: string
      }
      assert_human_caller: { Args: { p_action: string }; Returns: undefined }
      claim_calendar_feed: {
        Args: { p_feed_id: string; p_lease_seconds?: number }
        Returns: {
          active: boolean
          config: Json
          created_at: string
          id: string
          label: string
          last_sync_error: string | null
          last_sync_status: string | null
          last_synced_at: string | null
          provider: string
          sync_cursor: Json | null
          sync_lease_expires_at: string | null
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "calendar_feeds"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      confirm_syllabus_extraction: {
        Args: { p_extraction_id: string }
        Returns: undefined
      }
      reject_syllabus_extraction: {
        Args: { p_extraction_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
