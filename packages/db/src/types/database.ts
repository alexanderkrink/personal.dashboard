export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
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
      attendance_records: {
        Row: {
          created_at: string
          id: string
          occurrence_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          occurrence_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          occurrence_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_occurrence_id_fkey"
            columns: ["occurrence_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_occurrences"
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
      document_chunks: {
        Row: {
          chunk_hash: string
          content: string
          course_id: string
          created_at: string
          document_id: string | null
          embedding: string | null
          id: string
          locator: Json
          source: string
          token_count: number
          topic_id: string | null
          user_id: string
        }
        Insert: {
          chunk_hash: string
          content: string
          course_id: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          locator: Json
          source?: string
          token_count: number
          topic_id?: string | null
          user_id: string
        }
        Update: {
          chunk_hash?: string
          content?: string
          course_id?: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          locator?: Json
          source?: string
          token_count?: number
          topic_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_course_id_fkey"
            columns: ["course_id", "user_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "document_chunks_document_course_fkey"
            columns: ["document_id", "course_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "course_id"]
          },
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id", "user_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "document_chunks_topic_course_fkey"
            columns: ["topic_id", "course_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id", "course_id"]
          },
          {
            foreignKeyName: "document_chunks_topic_id_fkey"
            columns: ["topic_id", "user_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      document_merge_plans: {
        Row: {
          created_at: string
          document_id: string
          extraction_hash: string
          id: string
          plan: Json
          prompt_version: number
          user_id: string
        }
        Insert: {
          created_at?: string
          document_id: string
          extraction_hash: string
          id?: string
          plan: Json
          prompt_version: number
          user_id: string
        }
        Update: {
          created_at?: string
          document_id?: string
          extraction_hash?: string
          id?: string
          plan?: Json
          prompt_version?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_merge_plans_document_id_fkey"
            columns: ["document_id", "user_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      document_processing_events: {
        Row: {
          course_id: string
          created_at: string
          detail: string | null
          document_id: string
          id: number
          level: string
          step: string
          user_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          detail?: string | null
          document_id: string
          id?: never
          level?: string
          step: string
          user_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          detail?: string | null
          document_id?: string
          id?: never
          level?: string
          step?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_processing_events_course_id_fkey"
            columns: ["document_id", "course_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "course_id"]
          },
          {
            foreignKeyName: "document_processing_events_document_id_fkey"
            columns: ["document_id", "user_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      documents: {
        Row: {
          content_hash: string
          course_id: string
          coverage: Json | null
          created_at: string
          deep_review: string
          deep_reviewed_at: string | null
          extraction: Json | null
          extraction_fidelity: string | null
          failed_topics: Json
          failure_reason: string | null
          filename: string
          id: string
          kind: string
          mime_type: string
          processed_at: string | null
          session_label: string | null
          size_bytes: number
          status: Database["public"]["Enums"]["document_status"]
          storage_path: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content_hash: string
          course_id: string
          coverage?: Json | null
          created_at?: string
          deep_review?: string
          deep_reviewed_at?: string | null
          extraction?: Json | null
          extraction_fidelity?: string | null
          failed_topics?: Json
          failure_reason?: string | null
          filename: string
          id?: string
          kind: string
          mime_type: string
          processed_at?: string | null
          session_label?: string | null
          size_bytes: number
          status?: Database["public"]["Enums"]["document_status"]
          storage_path: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content_hash?: string
          course_id?: string
          coverage?: Json | null
          created_at?: string
          deep_review?: string
          deep_reviewed_at?: string | null
          extraction?: Json | null
          extraction_fidelity?: string | null
          failed_topics?: Json
          failure_reason?: string | null
          filename?: string
          id?: string
          kind?: string
          mime_type?: string
          processed_at?: string | null
          session_label?: string | null
          size_bytes?: number
          status?: Database["public"]["Enums"]["document_status"]
          storage_path?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_course_id_fkey"
            columns: ["course_id", "user_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      exam_reviews: {
        Row: {
          content: Json
          course_id: string
          created_at: string
          id: string
          input_hash: string
          model: string
          prompt_id: string
          prompt_version: number
          provider: string
          stale: boolean
          topic_snapshot: Json
          user_id: string
        }
        Insert: {
          content: Json
          course_id: string
          created_at?: string
          id?: string
          input_hash: string
          model: string
          prompt_id: string
          prompt_version: number
          provider: string
          stale?: boolean
          topic_snapshot: Json
          user_id: string
        }
        Update: {
          content?: Json
          course_id?: string
          created_at?: string
          id?: string
          input_hash?: string
          model?: string
          prompt_id?: string
          prompt_version?: number
          provider?: string
          stale?: boolean
          topic_snapshot?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_reviews_course_id_fkey"
            columns: ["course_id", "user_id"]
            isOneToOne: false
            referencedRelation: "courses"
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
      participation_logs: {
        Row: {
          created_at: string
          id: string
          kind: string
          note: string | null
          occurrence_id: string
          quality: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          note?: string | null
          occurrence_id: string
          quality?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
          occurrence_id?: string
          quality?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "participation_logs_occurrence_id_fkey"
            columns: ["occurrence_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_occurrences"
            referencedColumns: ["id", "user_id"]
          },
        ]
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
      talking_points: {
        Row: {
          body: string
          created_at: string
          id: string
          occurrence_id: string
          updated_at: string
          used: boolean
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          occurrence_id: string
          updated_at?: string
          used?: boolean
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          occurrence_id?: string
          updated_at?: string
          used?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "talking_points_occurrence_id_fkey"
            columns: ["occurrence_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_occurrences"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      topic_revisions: {
        Row: {
          change_summary: string
          created_at: string
          document_id: string | null
          id: string
          input_hash: string
          model: string
          needs_review: boolean
          page: Json
          prompt_id: string
          prompt_version: number
          provider: string
          review_notes: string[]
          revision: number
          source: string
          topic_id: string
          user_id: string
        }
        Insert: {
          change_summary: string
          created_at?: string
          document_id?: string | null
          id?: string
          input_hash: string
          model: string
          needs_review?: boolean
          page: Json
          prompt_id: string
          prompt_version: number
          provider: string
          review_notes?: string[]
          revision: number
          source?: string
          topic_id: string
          user_id: string
        }
        Update: {
          change_summary?: string
          created_at?: string
          document_id?: string | null
          id?: string
          input_hash?: string
          model?: string
          needs_review?: boolean
          page?: Json
          prompt_id?: string
          prompt_version?: number
          provider?: string
          review_notes?: string[]
          revision?: number
          source?: string
          topic_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "topic_revisions_document_id_fkey"
            columns: ["document_id", "user_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "topic_revisions_topic_id_fkey"
            columns: ["topic_id", "user_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      topic_sources: {
        Row: {
          created_at: string
          document_id: string
          id: string
          locators: Json
          merged_at_revision: number
          topic_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          document_id: string
          id?: string
          locators?: Json
          merged_at_revision: number
          topic_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          document_id?: string
          id?: string
          locators?: Json
          merged_at_revision?: number
          topic_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "topic_sources_document_id_fkey"
            columns: ["document_id", "user_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "topic_sources_topic_id_fkey"
            columns: ["topic_id", "user_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      topics: {
        Row: {
          course_id: string
          create_plan_key: string | null
          created_at: string
          exam_weight: number
          exam_weight_override: number | null
          id: string
          page: Json
          revision: number
          slug: string
          summary: string
          summary_embedding: string | null
          title: string
          title_embedding: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          course_id: string
          create_plan_key?: string | null
          created_at?: string
          exam_weight?: number
          exam_weight_override?: number | null
          id?: string
          page?: Json
          revision?: number
          slug: string
          summary?: string
          summary_embedding?: string | null
          title: string
          title_embedding?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          course_id?: string
          create_plan_key?: string | null
          created_at?: string
          exam_weight?: number
          exam_weight_override?: number | null
          id?: string
          page?: Json
          revision?: number
          slug?: string
          summary?: string
          summary_embedding?: string | null
          title?: string
          title_embedding?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "topics_course_id_fkey"
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
      create_topic_with_first_revision: {
        Args: {
          p_change_summary: string
          p_course_id: string
          p_create_plan_key?: string
          p_document_id: string
          p_input_hash: string
          p_model: string
          p_needs_review: boolean
          p_page: Json
          p_previous_page: Json
          p_prompt_id: string
          p_prompt_version: number
          p_provider: string
          p_review_notes: string[]
          p_slug: string
          p_source?: string
          p_summary: string
          p_title: string
          p_user_id: string
        }
        Returns: string
      }
      match_chunks: {
        Args: {
          p_course_id: string
          p_match_count?: number
          p_query_embedding: string
          p_source?: string
          p_topic_id?: string
          p_user_id: string
        }
        Returns: {
          content: string
          document_id: string
          id: string
          locator: Json
          similarity: number
          source: string
          topic_id: string
        }[]
      }
      reject_syllabus_extraction: {
        Args: { p_extraction_id: string }
        Returns: undefined
      }
    }
    Enums: {
      document_status:
        | "queued"
        | "validating"
        | "extracting"
        | "structuring"
        | "merging"
        | "embedding"
        | "ready"
        | "partial"
        | "failed"
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
    Enums: {
      document_status: [
        "queued",
        "validating",
        "extracting",
        "structuring",
        "merging",
        "embedding",
        "ready",
        "partial",
        "failed",
      ],
    },
  },
} as const

