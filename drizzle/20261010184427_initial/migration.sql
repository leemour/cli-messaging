CREATE TABLE `account_identities` (
	`account_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_messaged_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `account_identities_pk` PRIMARY KEY(`account_id`, `identity_id`),
	CONSTRAINT `fk_account_identities_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_account_identities_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`settings` text,
	`status` text,
	`updated_at` integer NOT NULL,
	`scope` text DEFAULT 'personal' NOT NULL,
	`organization_id` integer,
	CONSTRAINT `fk_accounts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `accounts_provider_external_id_unique` UNIQUE(`provider`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_actions` (
	`id` integer PRIMARY KEY,
	`actor_type` text NOT NULL,
	`actor_id` integer NOT NULL,
	`tool` text NOT NULL,
	`tier` text NOT NULL,
	`target_type` text,
	`target_id` integer,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `aliases` (
	`id` integer PRIMARY KEY,
	`aliasable_type` text NOT NULL,
	`aliasable_id` integer NOT NULL,
	`account_id` integer,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`display` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_aliases_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY,
	`attachable_type` text NOT NULL,
	`attachable_id` integer NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`mime` text,
	`name` text,
	`title` text,
	`url` text,
	`size` integer,
	`width` integer,
	`height` integer,
	`duration` real,
	`provider_ref` text,
	`local_path` text,
	`text` text,
	`normalized_text` text,
	`extraction` text,
	`extractor` text,
	`extraction_error` text,
	`content_sha256` text,
	`extracted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `attachments_attachable_type_attachable_id_position_unique` UNIQUE(`attachable_type`,`attachable_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `auto_tag_claims` (
	`chat_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`algorithm` text NOT NULL,
	`score` real NOT NULL,
	`fields` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `auto_tag_claims_pk` PRIMARY KEY(`chat_id`, `tag_id`),
	CONSTRAINT `fk_auto_tag_claims_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_auto_tag_claims_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`)
);
--> statement-breakpoint
CREATE TABLE `bot_updates` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`handled_at` integer,
	`error` text,
	`replayed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_bot_updates_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `bot_updates_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `bots` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`kind` text NOT NULL,
	`description` text,
	`owner_person_id` integer,
	`model` text,
	`token_digest` text,
	`last_seen_at` integer,
	`disabled_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_bots_owner_person_id_persons_id_fk` FOREIGN KEY (`owner_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `chat_members` (
	`chat_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `chat_members_pk` PRIMARY KEY(`chat_id`, `identity_id`),
	CONSTRAINT `fk_chat_members_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_chat_members_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`unread_count` integer,
	`last_message_at` integer,
	`participants_count` integer,
	`metadata` text,
	`updated_at` integer NOT NULL,
	`username` text,
	`membership_state` text,
	`searchable` integer DEFAULT 1 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`members_tracked_at` integer,
	`description` text,
	`details_fetched_at` integer,
	`created_at` integer NOT NULL,
	`parent_chat_id` integer,
	`scope` text,
	CONSTRAINT `fk_chats_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_chats_parent_chat_id_chats_id_fk` FOREIGN KEY (`parent_chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `chats_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `chunk_messages` (
	`chunk_id` integer PRIMARY KEY,
	`first_message_id` integer NOT NULL,
	`last_message_id` integer NOT NULL,
	`text_start` integer,
	`text_end` integer,
	CONSTRAINT `fk_chunk_messages_chunk_id_chunks_id_fk` FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_chunk_messages_first_message_id_messages_id_fk` FOREIGN KEY (`first_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_chunk_messages_last_message_id_messages_id_fk` FOREIGN KEY (`last_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` integer PRIMARY KEY,
	`chunkable_type` text NOT NULL,
	`chunkable_id` integer NOT NULL,
	`position` integer NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`content_hash` text NOT NULL,
	`scope` text,
	`account_id` integer,
	`project_id` integer,
	`occurred_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_chunks_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_chunks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `chunks_chunkable_type_chunkable_id_position_unique` UNIQUE(`chunkable_type`,`chunkable_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`conversation_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	CONSTRAINT `conversation_messages_pk` PRIMARY KEY(`conversation_id`, `message_id`),
	CONSTRAINT `fk_conversation_messages_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_messages_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `conversation_state` (
	`chat_id` integer PRIMARY KEY,
	`enabled_at` integer NOT NULL,
	`built_at` integer,
	`algorithm_version` integer,
	`current_build` integer,
	CONSTRAINT `fk_conversation_state_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`first_message_id` integer NOT NULL,
	`build` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`message_count` integer NOT NULL,
	`built_at` integer NOT NULL,
	`algorithm_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_conversations_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversations_first_message_id_messages_id_fk` FOREIGN KEY (`first_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY,
	`project_id` integer,
	`statement` text NOT NULL,
	`status` text NOT NULL,
	`decided_at` integer,
	`supersedes_id` integer,
	`confirmed_by_type` text,
	`confirmed_by_id` integer,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_decisions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_decisions_supersedes_id_decisions_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `decisions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `document_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `document_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `document_revisions` (
	`id` integer PRIMARY KEY,
	`document_id` integer NOT NULL,
	`body` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_document_revisions_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`)
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`location` text,
	`file_name` text,
	`extension` text,
	`url` text,
	`storage` text,
	`local_path` text,
	`mime` text,
	`size` integer,
	`content_hash` text,
	`front_matter` text,
	`body` text,
	`normalized_text` text,
	`extraction` text,
	`extraction_error` text,
	`language` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`export_path` text,
	`external_created_at` integer,
	`external_updated_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_documents_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `documents_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `email_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `email_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `email_mailboxes` (
	`email_id` integer NOT NULL,
	`mailbox_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `email_mailboxes_pk` PRIMARY KEY(`email_id`, `mailbox_id`),
	CONSTRAINT `fk_email_mailboxes_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`),
	CONSTRAINT `fk_email_mailboxes_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_recipients` (
	`id` integer PRIMARY KEY,
	`email_id` integer NOT NULL,
	`identity_id` integer,
	`address` text NOT NULL,
	`name` text,
	`role` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_email_recipients_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`),
	CONSTRAINT `fk_email_recipients_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_threads` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`subject` text,
	`last_email_at` integer,
	`emails_count` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_email_threads_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `email_threads_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `emails` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`email_thread_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`subject` text,
	`from_identity_id` integer,
	`from_address` text,
	`from_name` text,
	`sent_at` integer,
	`received_at` integer,
	`in_reply_to` text,
	`references` text,
	`body_text` text,
	`body_html` text,
	`snippet` text,
	`outgoing` integer,
	`read` integer,
	`flagged` integer,
	`draft` integer,
	`size` integer,
	`headers` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_emails_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_emails_email_thread_id_email_threads_id_fk` FOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`),
	CONSTRAINT `fk_emails_from_identity_id_identities_id_fk` FOREIGN KEY (`from_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `emails_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `embeddings` (
	`model` text NOT NULL,
	`content_hash` text NOT NULL,
	`dims` integer NOT NULL,
	`vector` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `embeddings_pk` PRIMARY KEY(`model`, `content_hash`)
);
--> statement-breakpoint
CREATE TABLE `event_series` (
	`id` integer PRIMARY KEY,
	`title` text,
	`recurrence` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY,
	`event_series_id` integer,
	`title` text,
	`description` text,
	`location` text,
	`starts_at` integer,
	`ends_at` integer,
	`timezone` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_events_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`)
);
--> statement-breakpoint
CREATE TABLE `fetch_leases` (
	`chat_id` integer NOT NULL,
	`anchor` text NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fetch_leases_pk` PRIMARY KEY(`chat_id`, `anchor`),
	CONSTRAINT `fk_fetch_leases_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`id` integer PRIMARY KEY,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`username` text,
	`name` text,
	`bot` integer,
	`phone_hmac` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`description` text,
	CONSTRAINT `identities_provider_external_id_unique` UNIQUE(`provider`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `identity_link_events` (
	`id` integer PRIMARY KEY,
	`identity_id` integer NOT NULL,
	`from_person_id` integer,
	`to_person_id` integer NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	`author` text NOT NULL,
	CONSTRAINT `fk_identity_link_events_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_identity_link_events_from_person_id_persons_id_fk` FOREIGN KEY (`from_person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_identity_link_events_to_person_id_persons_id_fk` FOREIGN KEY (`to_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `identity_links` (
	`identity_id` integer PRIMARY KEY,
	`person_id` integer NOT NULL,
	`method` text NOT NULL,
	`confidence` real NOT NULL,
	`created_at` integer NOT NULL,
	`author` text NOT NULL,
	`source` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_identity_links_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_identity_links_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `identity_revisions` (
	`id` integer PRIMARY KEY,
	`identity_id` integer NOT NULL,
	`name` text,
	`username` text,
	`description` text,
	`marks` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_identity_revisions_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `involvement_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `involvement_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `involvements` (
	`id` integer PRIMARY KEY,
	`person_id` integer,
	`identity_id` integer,
	`subject_type` text NOT NULL,
	`subject_id` integer NOT NULL,
	`role` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`scope` text NOT NULL,
	`account_id` integer,
	`project_id` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_involvements_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_involvements_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_involvements_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_involvements_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY,
	`from_type` text NOT NULL,
	`from_id` integer NOT NULL,
	`to_type` text,
	`to_id` integer,
	`kind` text NOT NULL,
	`anchor` text,
	`source` text NOT NULL,
	`target_text` text,
	`target_folded` text,
	`role` text,
	`evidence` text,
	`metadata` text,
	`confirmed` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`author` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_mailboxes_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `mailboxes_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_chat_messages` (
	`id` integer PRIMARY KEY,
	`meeting_id` integer NOT NULL,
	`external_id` text,
	`sent_at` integer NOT NULL,
	`sender_participant_id` integer,
	`sender_name` text,
	`recipient` text,
	`text` text NOT NULL,
	`normalized_text` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_chat_messages_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT `fk_meeting_chat_messages_sender_participant_id_meeting_participants_id_fk` FOREIGN KEY (`sender_participant_id`) REFERENCES `meeting_participants`(`id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `meeting_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_participants` (
	`id` integer PRIMARY KEY,
	`meeting_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`display_name` text,
	`email` text,
	`role` text,
	`joined_at` integer,
	`left_at` integer,
	`duration_ms` integer,
	`sessions` text,
	`external_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_participants_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT `fk_meeting_participants_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meeting_participants_meeting_id_identity_id_unique` UNIQUE(`meeting_id`,`identity_id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_series` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`event_series_id` integer,
	`title` text,
	`description` text,
	`kind` text,
	`recurrence` text,
	`host_identity_id` integer,
	`join_url` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_meeting_series_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_meeting_series_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`),
	CONSTRAINT `fk_meeting_series_host_identity_id_identities_id_fk` FOREIGN KEY (`host_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meeting_series_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_summaries` (
	`id` integer PRIMARY KEY,
	`meeting_id` integer NOT NULL,
	`source` text NOT NULL,
	`title` text,
	`overview` text,
	`sections` text,
	`next_steps` text,
	`content` text,
	`doc_url` text,
	`external_created_at` integer,
	`external_updated_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_summaries_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT `meeting_summaries_meeting_id_source_unique` UNIQUE(`meeting_id`,`source`)
);
--> statement-breakpoint
CREATE TABLE `meeting_transcript_rows` (
	`id` integer PRIMARY KEY,
	`meeting_transcript_id` integer NOT NULL,
	`position` integer NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`speaker_participant_id` integer,
	`speaker_name` text,
	`text` text NOT NULL,
	`normalized_text` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_transcript_rows_meeting_transcript_id_meeting_transcripts_id_fk` FOREIGN KEY (`meeting_transcript_id`) REFERENCES `meeting_transcripts`(`id`),
	CONSTRAINT `fk_meeting_transcript_rows_speaker_participant_id_meeting_participants_id_fk` FOREIGN KEY (`speaker_participant_id`) REFERENCES `meeting_participants`(`id`),
	CONSTRAINT `meeting_transcript_rows_meeting_transcript_id_position_unique` UNIQUE(`meeting_transcript_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `meeting_transcripts` (
	`id` integer PRIMARY KEY,
	`meeting_id` integer NOT NULL,
	`source` text NOT NULL,
	`format` text,
	`language` text,
	`content_hash` text,
	`external_created_at` integer,
	`superseded_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_meeting_transcripts_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`)
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`meeting_series_id` integer,
	`event_id` integer,
	`external_id` text NOT NULL,
	`title` text,
	`description` text,
	`location` text,
	`join_url` text,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`timezone` text,
	`host_identity_id` integer,
	`participants_count` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_meetings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_meetings_meeting_series_id_meeting_series_id_fk` FOREIGN KEY (`meeting_series_id`) REFERENCES `meeting_series`(`id`),
	CONSTRAINT `fk_meetings_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
	CONSTRAINT `fk_meetings_host_identity_id_identities_id_fk` FOREIGN KEY (`host_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meetings_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `member_counts` (
	`chat_id` integer NOT NULL,
	`date` text NOT NULL,
	`reported_count` integer,
	`listed_count` integer NOT NULL,
	`complete_list` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `member_counts_pk` PRIMARY KEY(`chat_id`, `date`),
	CONSTRAINT `fk_member_counts_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)
);
--> statement-breakpoint
CREATE TABLE `member_observation_members` (
	`member_observation_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`member_stay_id` integer NOT NULL,
	CONSTRAINT `member_observation_members_pk` PRIMARY KEY(`member_observation_id`, `identity_id`),
	CONSTRAINT `fk_member_observation_members_member_observation_id_member_observations_id_fk` FOREIGN KEY (`member_observation_id`) REFERENCES `member_observations`(`id`),
	CONSTRAINT `fk_member_observation_members_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_member_observation_members_member_stay_id_member_stays_id_fk` FOREIGN KEY (`member_stay_id`) REFERENCES `member_stays`(`id`)
);
--> statement-breakpoint
CREATE TABLE `member_observations` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`started_at` integer,
	`complete` integer NOT NULL,
	`reported_count` integer,
	`listed_count` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_member_observations_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)
);
--> statement-breakpoint
CREATE TABLE `member_stays` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`joined_at` integer,
	`invited_by_identity_id` integer,
	`role` text,
	`left_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_member_stays_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_member_stays_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_member_stays_invited_by_identity_id_identities_id_fk` FOREIGN KEY (`invited_by_identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`subject_type` text,
	`subject_id` integer,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`model` text,
	`confidence` real,
	`status` text NOT NULL,
	`last_verified_at` integer,
	`supersedes_id` integer,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_memories_supersedes_id_memories_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `memories`(`id`)
);
--> statement-breakpoint
CREATE TABLE `memory_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `memory_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `message_counter_observations` (
	`message_id` integer NOT NULL,
	`counter` text NOT NULL,
	`value` real NOT NULL,
	`created_at` integer NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `message_counter_observations_pk` PRIMARY KEY(`message_id`, `counter`),
	CONSTRAINT `fk_message_counter_observations_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `message_links` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`parent_id` integer,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` real NOT NULL,
	`method` text NOT NULL,
	`version` text,
	`batch` text,
	`build` integer,
	`created_at` integer NOT NULL,
	`stale_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_message_links_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_links_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_links_parent_id_messages_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `message_revisions` (
	`id` integer PRIMARY KEY,
	`message_id` integer NOT NULL,
	`text` text NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_message_revisions_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`)
);
--> statement-breakpoint
CREATE TABLE `message_stems_pending` (
	`id` integer PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `message_transcripts` (
	`id` integer PRIMARY KEY,
	`message_id` integer,
	`chat_id` integer NOT NULL,
	`message_external_id` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`heard_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_message_transcripts_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`),
	CONSTRAINT `fk_message_transcripts_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `message_transcripts_chat_id_message_external_id_unique` UNIQUE(`chat_id`,`message_external_id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`thread_external_id` text,
	`sender_identity_id` integer,
	`sender_chat_external_id` text,
	`sender_name` text,
	`sent_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`text` text NOT NULL,
	`reply_to_external_id` text,
	`reply_to` text,
	`forward` text,
	`outgoing` integer,
	`reactions` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`source` text NOT NULL,
	`normalized_text` text,
	`normalizer_version` integer,
	`mentions` text,
	`updated_at` integer NOT NULL,
	`thread_root_id` integer,
	CONSTRAINT `fk_messages_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_messages_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_messages_sender_identity_id_identities_id_fk` FOREIGN KEY (`sender_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_messages_thread_root_id_messages_id_fk` FOREIGN KEY (`thread_root_id`) REFERENCES `messages`(`id`),
	CONSTRAINT `messages_chat_id_external_id_unique` UNIQUE(`chat_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `note_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `note_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `note_revisions` (
	`id` integer PRIMARY KEY,
	`note_id` integer NOT NULL,
	`body` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_note_revisions_note_id_notes_id_fk` FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`)
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY,
	`notable_type` text NOT NULL,
	`notable_id` integer NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`author_type` text,
	`author_id` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`scope` text DEFAULT 'personal' NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `persons` (
	`id` integer PRIMARY KEY,
	`name` text,
	`owner` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`organization_id` integer,
	`account_id` integer,
	`scope` text DEFAULT 'personal' NOT NULL,
	`owner_type` text,
	`owner_id` integer,
	`tasks_count` integer DEFAULT 0 NOT NULL,
	`status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_projects_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_projects_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `proposed_actions` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`account_id` integer,
	`target_type` text,
	`target_id` integer,
	`payload` text,
	`reason` text,
	`status` text NOT NULL,
	`proposed_by_type` text NOT NULL,
	`proposed_by_id` integer NOT NULL,
	`decided_by_type` text,
	`decided_by_id` integer,
	`decided_at` integer,
	`executed_at` integer,
	`result` text,
	`error` text,
	`verdict` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_proposed_actions_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY,
	`task_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`due_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lease_until` integer,
	`receipt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_reminders_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `fk_reminders_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `search_index_state` (
	`name` text PRIMARY KEY,
	`watermark` integer NOT NULL,
	`filled_through` integer NOT NULL,
	`terms_through` integer NOT NULL,
	`normalizer_version` integer NOT NULL,
	`built_at` integer,
	`analyzer` text
);
--> statement-breakpoint
CREATE TABLE `searches` (
	`id` integer PRIMARY KEY,
	`name` text UNIQUE,
	`command` text NOT NULL,
	`params` text NOT NULL,
	`language` text NOT NULL,
	`version` integer NOT NULL,
	`fields_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_run_at` integer,
	`runs` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `store_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`account_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `sync_cursors_pk` PRIMARY KEY(`account_id`, `key`),
	CONSTRAINT `fk_sync_cursors_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `sync_ranges` (
	`chat_id` integer NOT NULL,
	`from_key` integer NOT NULL,
	`to_key` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `sync_ranges_pk` PRIMARY KEY(`chat_id`, `from_key`),
	CONSTRAINT `fk_sync_ranges_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)
);
--> statement-breakpoint
CREATE TABLE `syncs` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`counts` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_syncs_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `taggings` (
	`id` integer PRIMARY KEY,
	`tag_id` integer NOT NULL,
	`taggable_type` text NOT NULL,
	`taggable_id` integer NOT NULL,
	`main` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`author_type` text,
	`author_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_taggings_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`),
	CONSTRAINT `taggings_tag_id_taggable_type_taggable_id_unique` UNIQUE(`tag_id`,`taggable_type`,`taggable_id`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`kind` text DEFAULT 'tag' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_assignments` (
	`id` integer PRIMARY KEY,
	`task_id` integer NOT NULL,
	`assignee_type` text NOT NULL,
	`assignee_id` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_task_assignments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `task_assignments_task_id_assignee_type_assignee_id_role_unique` UNIQUE(`task_id`,`assignee_type`,`assignee_id`,`role`)
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` integer PRIMARY KEY,
	`task_id` integer NOT NULL,
	`actor_type` text,
	`actor_id` integer,
	`kind` text NOT NULL,
	`changes` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_task_events_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY,
	`project_id` integer NOT NULL,
	`number` integer NOT NULL,
	`key` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer,
	`parent_id` integer,
	`due_at` integer,
	`started_at` integer,
	`closed_at` integer,
	`closed_by_type` text,
	`closed_by_id` integer,
	`close_reason` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`source` text NOT NULL,
	`package_id` text UNIQUE,
	`source_locator` text,
	`source_kind` text,
	`source_group` text,
	`resolution` text,
	`verdict` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_tasks_parent_id_tasks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `tasks_project_id_number_unique` UNIQUE(`project_id`,`number`)
);
--> statement-breakpoint
CREATE INDEX `account_identities_by_identity_id` ON `account_identities` (`identity_id`);--> statement-breakpoint
CREATE INDEX `accounts_by_organization_id` ON `accounts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `agent_actions_by_started_at_desc` ON `agent_actions` ("started_at" desc);--> statement-breakpoint
CREATE INDEX `agent_actions_by_actor_type_actor_id` ON `agent_actions` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `agent_actions_by_target_type_target_id` ON `agent_actions` (`target_type`,`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `aliases_displayed` ON `aliases` (`aliasable_type`,`aliasable_id`,ifnull("account_id", 0)) WHERE display = 1;--> statement-breakpoint
CREATE INDEX `aliases_by_aliasable_type_aliasable_id` ON `aliases` (`aliasable_type`,`aliasable_id`);--> statement-breakpoint
CREATE INDEX `aliases_by_account_id` ON `aliases` (`account_id`);--> statement-breakpoint
CREATE INDEX `auto_tag_claims_by_tag_id` ON `auto_tag_claims` (`tag_id`);--> statement-breakpoint
CREATE INDEX `bot_updates_by_account_id_received_at_desc` ON `bot_updates` (`account_id`,"received_at" desc);--> statement-breakpoint
CREATE INDEX `bots_by_owner_person_id` ON `bots` (`owner_person_id`);--> statement-breakpoint
CREATE INDEX `chat_members_by_identity_id` ON `chat_members` (`identity_id`);--> statement-breakpoint
CREATE INDEX `chats_by_recency` ON `chats` (`account_id`,"last_message_at" desc);--> statement-breakpoint
CREATE INDEX `chats_by_parent_chat_id` ON `chats` (`parent_chat_id`);--> statement-breakpoint
CREATE INDEX `chunk_messages_by_first_message_id` ON `chunk_messages` (`first_message_id`);--> statement-breakpoint
CREATE INDEX `chunk_messages_by_last_message_id` ON `chunk_messages` (`last_message_id`);--> statement-breakpoint
CREATE INDEX `chunks_by_content_hash` ON `chunks` (`content_hash`);--> statement-breakpoint
CREATE INDEX `chunks_by_scope_occurred_at` ON `chunks` (`scope`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `chunks_by_account_id` ON `chunks` (`account_id`);--> statement-breakpoint
CREATE INDEX `chunks_by_project_id` ON `chunks` (`project_id`);--> statement-breakpoint
CREATE INDEX `conversation_messages_by_message_id` ON `conversation_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `conversations_by_chat` ON `conversations` (`chat_id`,`build`,`first_at`);--> statement-breakpoint
CREATE INDEX `conversations_by_first_message_id` ON `conversations` (`first_message_id`);--> statement-breakpoint
CREATE INDEX `decisions_by_project_id` ON `decisions` (`project_id`);--> statement-breakpoint
CREATE INDEX `decisions_by_supersedes_id` ON `decisions` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `decisions_by_confirmed_by_type_confirmed_by_id` ON `decisions` (`confirmed_by_type`,`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `document_revisions_by_document_id` ON `document_revisions` (`document_id`);--> statement-breakpoint
CREATE INDEX `email_mailboxes_by_mailbox_id` ON `email_mailboxes` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `email_recipients_by_email_id` ON `email_recipients` (`email_id`);--> statement-breakpoint
CREATE INDEX `email_recipients_by_identity_id` ON `email_recipients` (`identity_id`);--> statement-breakpoint
CREATE INDEX `emails_by_time` ON `emails` (`account_id`,"sent_at" desc);--> statement-breakpoint
CREATE INDEX `emails_by_email_thread_id` ON `emails` (`email_thread_id`);--> statement-breakpoint
CREATE INDEX `emails_by_from_identity_id` ON `emails` (`from_identity_id`);--> statement-breakpoint
CREATE INDEX `events_by_time` ON `events` (`starts_at`);--> statement-breakpoint
CREATE INDEX `events_by_event_series_id` ON `events` (`event_series_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_identity_id` ON `identity_link_events` (`identity_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_from_person_id` ON `identity_link_events` (`from_person_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_to_person_id` ON `identity_link_events` (`to_person_id`);--> statement-breakpoint
CREATE INDEX `identity_links_by_person_id` ON `identity_links` (`person_id`);--> statement-breakpoint
CREATE INDEX `identity_revisions_by_identity` ON `identity_revisions` (`identity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `involvements_by_person` ON `involvements` (`person_id`,"occurred_at" desc);--> statement-breakpoint
CREATE INDEX `involvements_by_identity` ON `involvements` (`identity_id`,"occurred_at" desc);--> statement-breakpoint
CREATE INDEX `involvements_by_subject_type_subject_id` ON `involvements` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `involvements_by_account_id` ON `involvements` (`account_id`);--> statement-breakpoint
CREATE INDEX `involvements_by_project_id` ON `involvements` (`project_id`);--> statement-breakpoint
CREATE INDEX `links_unresolved` ON `links` (`target_folded`) WHERE to_id IS NULL;--> statement-breakpoint
CREATE INDEX `links_by_from_type_from_id` ON `links` (`from_type`,`from_id`);--> statement-breakpoint
CREATE INDEX `links_by_to_type_to_id` ON `links` (`to_type`,`to_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_chat_messages_by_meeting_id_external_id` ON `meeting_chat_messages` (`meeting_id`,`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `meeting_chat_messages_by_meeting_id` ON `meeting_chat_messages` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_chat_messages_by_sender_participant_id` ON `meeting_chat_messages` (`sender_participant_id`);--> statement-breakpoint
CREATE INDEX `meeting_participants_by_identity_id` ON `meeting_participants` (`identity_id`);--> statement-breakpoint
CREATE INDEX `meeting_series_by_event_series_id` ON `meeting_series` (`event_series_id`);--> statement-breakpoint
CREATE INDEX `meeting_series_by_host_identity_id` ON `meeting_series` (`host_identity_id`);--> statement-breakpoint
CREATE INDEX `meeting_transcript_rows_by_speaker_participant_id` ON `meeting_transcript_rows` (`speaker_participant_id`);--> statement-breakpoint
CREATE INDEX `meeting_transcripts_by_meeting_id` ON `meeting_transcripts` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_time` ON `meetings` (`account_id`,"started_at" desc);--> statement-breakpoint
CREATE INDEX `meetings_by_meeting_series_id` ON `meetings` (`meeting_series_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_event_id` ON `meetings` (`event_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_host_identity_id` ON `meetings` (`host_identity_id`);--> statement-breakpoint
CREATE INDEX `member_observation_members_by_member_stay_id` ON `member_observation_members` (`member_stay_id`);--> statement-breakpoint
CREATE INDEX `member_observation_members_by_identity_id` ON `member_observation_members` (`identity_id`);--> statement-breakpoint
CREATE INDEX `member_observations_by_chat_id_observed_at_id` ON `member_observations` (`chat_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_stays_open` ON `member_stays` (`chat_id`,`identity_id`) WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX `member_stays_by_identity_id` ON `member_stays` (`identity_id`);--> statement-breakpoint
CREATE INDEX `member_stays_by_invited_by_identity_id` ON `member_stays` (`invited_by_identity_id`);--> statement-breakpoint
CREATE INDEX `memories_by_subject_type_subject_id` ON `memories` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `memories_by_author_type_author_id` ON `memories` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `memories_by_supersedes_id` ON `memories` (`supersedes_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_links_unique` ON `message_links` (`message_id`,ifnull("parent_id", 0),`source`,`kind`,ifnull("build", 0));--> statement-breakpoint
CREATE INDEX `message_links_by_build` ON `message_links` (`chat_id`,`build`);--> statement-breakpoint
CREATE INDEX `message_links_by_parent_id` ON `message_links` (`parent_id`);--> statement-breakpoint
CREATE INDEX `message_revisions_by_message_id` ON `message_revisions` (`message_id`);--> statement-breakpoint
CREATE INDEX `message_transcripts_by_message_id` ON `message_transcripts` (`message_id`);--> statement-breakpoint
CREATE INDEX `messages_by_time` ON `messages` (`chat_id`,"sent_at" desc);--> statement-breakpoint
CREATE INDEX `messages_by_reply` ON `messages` (`chat_id`,`reply_to_external_id`) WHERE reply_to_external_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `messages_by_account` ON `messages` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `messages_to_normalize` ON `messages` (`id`) WHERE normalized_text IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `messages_by_sender_identity_id` ON `messages` (`sender_identity_id`);--> statement-breakpoint
CREATE INDEX `messages_by_thread_root_id` ON `messages` (`thread_root_id`);--> statement-breakpoint
CREATE INDEX `note_revisions_by_note_id` ON `note_revisions` (`note_id`);--> statement-breakpoint
CREATE INDEX `notes_by_notable_type_notable_id` ON `notes` (`notable_type`,`notable_id`);--> statement-breakpoint
CREATE INDEX `notes_by_author_type_author_id` ON `notes` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `projects_by_organization_id` ON `projects` (`organization_id`);--> statement-breakpoint
CREATE INDEX `projects_by_account_id` ON `projects` (`account_id`);--> statement-breakpoint
CREATE INDEX `projects_by_owner_type_owner_id` ON `projects` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_status_created_at` ON `proposed_actions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_account_id` ON `proposed_actions` (`account_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_target_type_target_id` ON `proposed_actions` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_proposed_by_type_proposed_by_id` ON `proposed_actions` (`proposed_by_type`,`proposed_by_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_by_decided_by_type_decided_by_id` ON `proposed_actions` (`decided_by_type`,`decided_by_id`);--> statement-breakpoint
CREATE INDEX `reminders_due` ON `reminders` (`account_id`,`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `reminders_by_task_id` ON `reminders` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `searches_history` ON `searches` (`command`,`params`) WHERE name IS NULL;--> statement-breakpoint
CREATE INDEX `searches_by_last_run` ON `searches` ("last_run_at" desc);--> statement-breakpoint
CREATE INDEX `syncs_by_account_id` ON `syncs` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `taggings_main_topic` ON `taggings` (`taggable_type`,`taggable_id`) WHERE main = 1;--> statement-breakpoint
CREATE INDEX `taggings_by_author_type_author_id` ON `taggings` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `task_assignments_by_assignee_type_assignee_id` ON `task_assignments` (`assignee_type`,`assignee_id`);--> statement-breakpoint
CREATE INDEX `task_events_by_task_id` ON `task_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_events_by_actor_type_actor_id` ON `task_events` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_status` ON `tasks` (`project_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_by_project_id_source_locator` ON `tasks` (`project_id`,`source_locator`);--> statement-breakpoint
CREATE INDEX `tasks_by_source_group` ON `tasks` (`source_group`);--> statement-breakpoint
CREATE INDEX `tasks_by_parent_id` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_closed_by_type_closed_by_id` ON `tasks` (`closed_by_type`,`closed_by_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_author_type_author_id` ON `tasks` (`author_type`,`author_id`);
--> statement-breakpoint
-- Trigram indexes over names and text, kept by triggers; external content, so their rowid is the row's id.
CREATE VIRTUAL TABLE identities_fts USING fts5(name, username, content='identities', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER identities_fts_ai AFTER INSERT ON identities BEGIN
  INSERT INTO identities_fts (rowid, name, username) VALUES (new.id, new.name, new.username);
END;--> statement-breakpoint
CREATE TRIGGER identities_fts_au AFTER UPDATE OF name, username ON identities BEGIN
  INSERT INTO identities_fts (identities_fts, rowid, name, username) VALUES ('delete', old.id, old.name, old.username);
  INSERT INTO identities_fts (rowid, name, username) VALUES (new.id, new.name, new.username);
END;--> statement-breakpoint
CREATE TRIGGER identities_fts_ad AFTER DELETE ON identities BEGIN
  INSERT INTO identities_fts (identities_fts, rowid, name, username) VALUES ('delete', old.id, old.name, old.username);
END;--> statement-breakpoint
CREATE VIRTUAL TABLE chats_fts USING fts5(title, content='chats', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER chats_fts_ai AFTER INSERT ON chats BEGIN
  INSERT INTO chats_fts (rowid, title) VALUES (new.id, new.title);
END;--> statement-breakpoint
CREATE TRIGGER chats_fts_au AFTER UPDATE OF title ON chats BEGIN
  INSERT INTO chats_fts (chats_fts, rowid, title) VALUES ('delete', old.id, old.title);
  INSERT INTO chats_fts (rowid, title) VALUES (new.id, new.title);
END;--> statement-breakpoint
CREATE TRIGGER chats_fts_ad AFTER DELETE ON chats BEGIN
  INSERT INTO chats_fts (chats_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;--> statement-breakpoint
-- Trigram for message text (owner, 2026-09-29): a search finds any three letters inside a word.
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;--> statement-breakpoint
CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;--> statement-breakpoint
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;--> statement-breakpoint
CREATE TRIGGER chats_count_ai AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count + 1 WHERE id = new.chat_id;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_ad AFTER DELETE ON messages WHEN old.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count - 1 WHERE id = old.chat_id;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_tombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  UPDATE chats SET message_count = message_count - 1 WHERE id = new.chat_id;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_untombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count + 1 WHERE id = new.chat_id;
END;--> statement-breakpoint
-- Words of the normalized text, ranked by bm25. Contentless with delete support: an index filled in
-- batches after its triggers exist stays consistent only this way. `scope` holds `c<chat_id>` and
-- `s<sender_identity_id>` so a small chat or a sender is filtered inside the index.
CREATE VIRTUAL TABLE message_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
-- 'col', not 'row': the scope tokens must never come back as a word or a correction.
CREATE VIRTUAL TABLE message_words_vocab USING fts5vocab(message_words, 'col');--> statement-breakpoint
CREATE TRIGGER message_words_ai AFTER INSERT ON messages WHEN new.normalized_text <> '' BEGIN
  INSERT INTO message_words (rowid, normalized_text, scope)
    VALUES (new.id, new.normalized_text, 'c' || new.chat_id || coalesce(' s' || new.sender_identity_id, ''));
END;--> statement-breakpoint
-- Every re-save of a message sets these columns; only a real change may touch the index.
CREATE TRIGGER message_words_au AFTER UPDATE OF normalized_text, sender_identity_id, chat_id ON messages
  WHEN old.normalized_text IS NOT new.normalized_text
    OR old.sender_identity_id IS NOT new.sender_identity_id
    OR old.chat_id IS NOT new.chat_id BEGIN
  DELETE FROM message_words WHERE rowid = old.id;
  INSERT INTO message_words (rowid, normalized_text, scope)
    SELECT new.id, new.normalized_text, 'c' || new.chat_id || coalesce(' s' || new.sender_identity_id, '')
    WHERE new.normalized_text <> '';
END;--> statement-breakpoint
CREATE TRIGGER message_words_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_words WHERE rowid = old.id;
END;--> statement-breakpoint
-- Snowball stems, shaped like `message_words` so its `scope` filter and bm25 weights carry over. No prefix
-- index: wildcards never read stems. SQL cannot stem, so the triggers only queue the row and JS writes the
-- stems. Every `*_stems` index below follows this recipe.
CREATE VIRTUAL TABLE message_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER message_stems_ai AFTER INSERT ON messages WHEN new.text <> '' BEGIN
  INSERT OR IGNORE INTO message_stems_pending (id) VALUES (new.id);
END;--> statement-breakpoint
CREATE TRIGGER message_stems_au AFTER UPDATE OF text, sender_identity_id, chat_id ON messages
  WHEN old.text IS NOT new.text
    OR old.sender_identity_id IS NOT new.sender_identity_id
    OR old.chat_id IS NOT new.chat_id BEGIN
  INSERT OR IGNORE INTO message_stems_pending (id) VALUES (new.id);
END;--> statement-breakpoint
CREATE TRIGGER message_stems_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_stems WHERE rowid = old.id;
  DELETE FROM message_stems_pending WHERE id = old.id;
END;--> statement-breakpoint
-- Words of an attachment's text, rowid = attachment id. Apart from message_words so `text:` stays what was
-- written and a file's words never rank a message.
CREATE VIRTUAL TABLE attachment_words USING fts5(
  normalized_text,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER attachment_words_ai AFTER INSERT ON attachments WHEN new.normalized_text <> '' BEGIN
  INSERT INTO attachment_words (rowid, normalized_text) VALUES (new.id, new.normalized_text);
END;--> statement-breakpoint
CREATE TRIGGER attachment_words_au AFTER UPDATE OF normalized_text ON attachments
  WHEN old.normalized_text IS NOT new.normalized_text BEGIN
  DELETE FROM attachment_words WHERE rowid = old.id;
  INSERT INTO attachment_words (rowid, normalized_text)
    SELECT new.id, new.normalized_text WHERE new.normalized_text <> '';
END;--> statement-breakpoint
CREATE TRIGGER attachment_words_ad AFTER DELETE ON attachments BEGIN
  DELETE FROM attachment_words WHERE rowid = old.id;
END;--> statement-breakpoint
-- Polymorphic rows have no foreign key to cascade by: these keep what hangs off a message, a chat, an
-- identity or an account from outliving it, whichever build deletes it.
CREATE TRIGGER message_tombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  UPDATE attachments SET text = NULL, normalized_text = NULL
    WHERE attachable_type = 'message' AND attachable_id = new.id;
  DELETE FROM taggings WHERE taggable_type = 'message' AND taggable_id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER message_ad AFTER DELETE ON messages BEGIN
  DELETE FROM attachments WHERE attachable_type = 'message' AND attachable_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'message' AND taggable_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER chat_bd BEFORE DELETE ON chats BEGIN
  DELETE FROM auto_tag_claims WHERE chat_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'chat' AND taggable_id = old.id;
  DELETE FROM aliases WHERE aliasable_type = 'chat' AND aliasable_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER identity_bd BEFORE DELETE ON identities BEGIN
  DELETE FROM aliases WHERE aliasable_type = 'identity' AND aliasable_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER account_bd BEFORE DELETE ON accounts BEGIN
  DELETE FROM aliases WHERE account_id = old.id;
  DELETE FROM reminders WHERE account_id = old.id;
  DELETE FROM bot_updates WHERE account_id = old.id;
  DELETE FROM links WHERE from_type = 'account' AND from_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER reminders_task_closed AFTER UPDATE OF status ON tasks
  WHEN new.status IN ('done', 'dismissed') AND old.status NOT IN ('done', 'dismissed') BEGIN
  UPDATE reminders SET state = 'cancelled', receipt = NULL, lease_until = NULL, revision = revision + 1
    WHERE task_id = new.id AND state IN ('pending', 'leased');
END;--> statement-breakpoint
-- Documents, notes, emails and meetings: written by JS from a queue, not by triggers, because the words are
-- normalized and the stems computed in JS; every writer only has to enqueue. The words indexes follow
-- `message_words` (prefix index, a 'col' vocabulary).
CREATE VIRTUAL TABLE document_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE document_words_vocab USING fts5vocab(document_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE document_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER document_index_ai AFTER INSERT ON documents BEGIN
  INSERT OR IGNORE INTO document_index_pending (indexable_type, id) VALUES ('document', new.id);
END;--> statement-breakpoint
CREATE TRIGGER document_index_au AFTER UPDATE OF title, body, deleted_at, account_id ON documents
  WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at
    OR old.account_id IS NOT new.account_id BEGIN
  INSERT OR IGNORE INTO document_index_pending (indexable_type, id) VALUES ('document', new.id);
END;--> statement-breakpoint
CREATE TRIGGER document_tombstone AFTER UPDATE OF deleted_at ON documents
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = new.id;
END;--> statement-breakpoint
-- A vector is keyed by text alone, so it goes only when no other chunk or conversation chunk still uses it.
CREATE TRIGGER document_bd BEFORE DELETE ON documents BEGIN
  DELETE FROM embeddings WHERE content_hash IN (
    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'document' AND k.chunkable_id = old.id
      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash
        AND NOT (o.chunkable_type = 'document' AND o.chunkable_id = old.id)));
  DELETE FROM chunks WHERE chunkable_type = 'document' AND chunkable_id = old.id;
  DELETE FROM document_words WHERE rowid = old.id;
  DELETE FROM document_stems WHERE rowid = old.id;
  DELETE FROM document_index_pending WHERE indexable_type = 'document' AND id = old.id;
  DELETE FROM document_revisions WHERE document_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = old.id;
  DELETE FROM links WHERE from_type = 'document' AND from_id = old.id;
END;--> statement-breakpoint
CREATE VIRTUAL TABLE note_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE note_words_vocab USING fts5vocab(note_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE note_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER note_index_ai AFTER INSERT ON notes BEGIN
  INSERT OR IGNORE INTO note_index_pending (indexable_type, id) VALUES ('note', new.id);
END;--> statement-breakpoint
CREATE TRIGGER note_index_au AFTER UPDATE OF title, body, deleted_at, notable_type, notable_id ON notes
  WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at
    OR old.notable_type IS NOT new.notable_type OR old.notable_id IS NOT new.notable_id BEGIN
  INSERT OR IGNORE INTO note_index_pending (indexable_type, id) VALUES ('note', new.id);
END;--> statement-breakpoint
CREATE TRIGGER note_tombstone AFTER UPDATE OF deleted_at ON notes
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  DELETE FROM taggings WHERE taggable_type = 'note' AND taggable_id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER note_bd BEFORE DELETE ON notes BEGIN
  DELETE FROM embeddings WHERE content_hash IN (
    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'note' AND k.chunkable_id = old.id
      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash
        AND NOT (o.chunkable_type = 'note' AND o.chunkable_id = old.id)));
  DELETE FROM chunks WHERE chunkable_type = 'note' AND chunkable_id = old.id;
  DELETE FROM note_words WHERE rowid = old.id;
  DELETE FROM note_stems WHERE rowid = old.id;
  DELETE FROM note_index_pending WHERE indexable_type = 'note' AND id = old.id;
  DELETE FROM note_revisions WHERE note_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'note' AND taggable_id = old.id;
  DELETE FROM links WHERE from_type = 'note' AND from_id = old.id;
END;--> statement-breakpoint
CREATE VIRTUAL TABLE memory_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE memory_words_vocab USING fts5vocab(memory_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE memory_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER memory_index_ai AFTER INSERT ON memories BEGIN
  INSERT OR IGNORE INTO memory_index_pending (indexable_type, id) VALUES ('memory', new.id);
END;--> statement-breakpoint
CREATE TRIGGER memory_index_au AFTER UPDATE OF body, status, scope, subject_type, subject_id ON memories
  WHEN old.body IS NOT new.body OR old.status IS NOT new.status OR old.scope IS NOT new.scope
    OR old.subject_type IS NOT new.subject_type OR old.subject_id IS NOT new.subject_id BEGIN
  INSERT OR IGNORE INTO memory_index_pending (indexable_type, id) VALUES ('memory', new.id);
END;--> statement-breakpoint
-- A memory's evidence is links from it; they go with it, the sources they point at stay.
CREATE TRIGGER memory_bd BEFORE DELETE ON memories BEGIN
  DELETE FROM embeddings WHERE content_hash IN (
    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'memory' AND k.chunkable_id = old.id
      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash
        AND NOT (o.chunkable_type = 'memory' AND o.chunkable_id = old.id)));
  DELETE FROM chunks WHERE chunkable_type = 'memory' AND chunkable_id = old.id;
  DELETE FROM memory_words WHERE rowid = old.id;
  DELETE FROM memory_stems WHERE rowid = old.id;
  DELETE FROM memory_index_pending WHERE indexable_type = 'memory' AND id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'memory' AND taggable_id = old.id;
  DELETE FROM links WHERE from_type = 'memory' AND from_id = old.id;
END;--> statement-breakpoint
CREATE VIRTUAL TABLE email_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE email_words_vocab USING fts5vocab(email_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE email_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER email_index_ai AFTER INSERT ON emails BEGIN
  INSERT OR IGNORE INTO email_index_pending (indexable_type, id) VALUES ('email', new.id);
END;--> statement-breakpoint
CREATE TRIGGER email_index_au AFTER UPDATE OF subject, body_text, deleted_at, email_thread_id ON emails
  WHEN old.subject IS NOT new.subject OR old.body_text IS NOT new.body_text
    OR old.deleted_at IS NOT new.deleted_at OR old.email_thread_id IS NOT new.email_thread_id BEGIN
  INSERT OR IGNORE INTO email_index_pending (indexable_type, id) VALUES ('email', new.id);
END;--> statement-breakpoint
CREATE TRIGGER email_bd BEFORE DELETE ON emails BEGIN
  DELETE FROM embeddings WHERE content_hash IN (
    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'email' AND k.chunkable_id = old.id
      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash
        AND NOT (o.chunkable_type = 'email' AND o.chunkable_id = old.id)));
  DELETE FROM chunks WHERE chunkable_type = 'email' AND chunkable_id = old.id;
  DELETE FROM email_recipients WHERE email_id = old.id;
  DELETE FROM email_mailboxes WHERE email_id = old.id;
  DELETE FROM email_words WHERE rowid = old.id;
  DELETE FROM email_stems WHERE rowid = old.id;
  DELETE FROM email_index_pending WHERE indexable_type = 'email' AND id = old.id;
  DELETE FROM attachments WHERE attachable_type = 'email' AND attachable_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'email' AND taggable_id = old.id;
END;--> statement-breakpoint
-- Three tables feed the meeting index and their ids overlap, so the rowid scheme is the indexer's: a change
-- or a delete only queues the row, and the drain removes what it finds gone.
CREATE VIRTUAL TABLE meeting_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE meeting_words_vocab USING fts5vocab(meeting_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE meeting_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER meeting_transcript_row_index_ai AFTER INSERT ON meeting_transcript_rows BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_transcript_row_index_au AFTER UPDATE OF text ON meeting_transcript_rows
  WHEN old.text IS NOT new.text BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_transcript_row_index_ad AFTER DELETE ON meeting_transcript_rows BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', old.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_chat_message_index_ai AFTER INSERT ON meeting_chat_messages BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_chat_message_index_au AFTER UPDATE OF text ON meeting_chat_messages
  WHEN old.text IS NOT new.text BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_chat_message_index_ad AFTER DELETE ON meeting_chat_messages BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', old.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_summary_index_ai AFTER INSERT ON meeting_summaries BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_summary_index_au AFTER UPDATE OF title, overview, sections, next_steps, content ON meeting_summaries
  WHEN old.title IS NOT new.title OR old.overview IS NOT new.overview OR old.sections IS NOT new.sections
    OR old.next_steps IS NOT new.next_steps OR old.content IS NOT new.content BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_summary_index_ad AFTER DELETE ON meeting_summaries BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', old.id);
END;--> statement-breakpoint
-- Drizzle cannot declare WITHOUT ROWID, so the vocabulary is written here and not in schema.ts.
CREATE TABLE search_terms (
  term   TEXT PRIMARY KEY,
  length INTEGER NOT NULL
) WITHOUT ROWID;--> statement-breakpoint
CREATE TABLE search_term_trigrams (
  trigram TEXT NOT NULL,
  length  INTEGER NOT NULL,
  term    TEXT NOT NULL,
  PRIMARY KEY (trigram, length, term)
) WITHOUT ROWID;--> statement-breakpoint
-- Who took part in what. A change only queues the thing it touches; the drain recomputes that thing's rows,
-- so no write parses `mentions` and no sync rebuilds the whole index. A person relinked keeps their rows.
CREATE TRIGGER involvement_message_ai AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('message', new.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_message_au AFTER UPDATE OF sender_identity_id, mentions, deleted_at, sent_at, chat_id ON messages
  WHEN old.sender_identity_id IS NOT new.sender_identity_id OR old.mentions IS NOT new.mentions
    OR old.deleted_at IS NOT new.deleted_at OR old.sent_at IS NOT new.sent_at OR old.chat_id IS NOT new.chat_id BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('message', new.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_message_ad AFTER DELETE ON messages BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('message', old.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_chat_member_ai AFTER INSERT ON chat_members BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('chat', new.chat_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_chat_member_ad AFTER DELETE ON chat_members BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('chat', old.chat_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_chat_scope AFTER UPDATE OF scope ON chats WHEN old.scope IS NOT new.scope BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('chat', new.id);
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'message', id FROM messages WHERE chat_id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER involvement_account_scope AFTER UPDATE OF scope ON accounts WHEN old.scope IS NOT new.scope BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'chat', id FROM chats WHERE account_id = new.id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'message', id FROM messages WHERE account_id = new.id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'meeting', id FROM meetings WHERE account_id = new.id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', id FROM emails WHERE account_id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER involvement_meeting_au AFTER UPDATE OF deleted_at, started_at ON meetings
  WHEN old.deleted_at IS NOT new.deleted_at OR old.started_at IS NOT new.started_at BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', new.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_meeting_ad AFTER DELETE ON meetings BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', old.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_meeting_participant_ai AFTER INSERT ON meeting_participants BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', new.meeting_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_meeting_participant_au AFTER UPDATE OF identity_id ON meeting_participants WHEN old.identity_id IS NOT new.identity_id BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', new.meeting_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_meeting_participant_ad AFTER DELETE ON meeting_participants BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', old.meeting_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_email_ai AFTER INSERT ON emails BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', new.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_email_au AFTER UPDATE OF from_identity_id, deleted_at, sent_at, received_at ON emails
  WHEN old.from_identity_id IS NOT new.from_identity_id OR old.deleted_at IS NOT new.deleted_at
    OR old.sent_at IS NOT new.sent_at OR old.received_at IS NOT new.received_at BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', new.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_email_ad AFTER DELETE ON emails BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', old.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_email_recipient_ai AFTER INSERT ON email_recipients BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', new.email_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_email_recipient_ad AFTER DELETE ON email_recipients BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', old.email_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_task_ai AFTER INSERT ON tasks BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', new.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_task_au AFTER UPDATE OF author_type, author_id, deleted_at, project_id ON tasks
  WHEN old.author_type IS NOT new.author_type OR old.author_id IS NOT new.author_id
    OR old.deleted_at IS NOT new.deleted_at OR old.project_id IS NOT new.project_id BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', new.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_task_ad AFTER DELETE ON tasks BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', old.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_task_assignment_ai AFTER INSERT ON task_assignments BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', new.task_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_task_assignment_ad AFTER DELETE ON task_assignments BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', old.task_id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_project_scope AFTER UPDATE OF scope ON projects WHEN old.scope IS NOT new.scope BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('project', new.id);
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'task', id FROM tasks WHERE project_id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER involvement_document_au AFTER UPDATE OF deleted_at ON documents WHEN old.deleted_at IS NOT new.deleted_at BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('document', new.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_document_ad AFTER DELETE ON documents BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('document', old.id);
END;--> statement-breakpoint
CREATE TRIGGER involvement_link_ai AFTER INSERT ON links BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES (new.from_type, new.from_id);
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT new.to_type, new.to_id
    WHERE new.from_type IN ('person', 'identity') AND new.to_id IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER involvement_link_au AFTER UPDATE ON links BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES (old.from_type, old.from_id);
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT old.to_type, old.to_id
    WHERE old.from_type IN ('person', 'identity') AND old.to_id IS NOT NULL;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES (new.from_type, new.from_id);
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT new.to_type, new.to_id
    WHERE new.from_type IN ('person', 'identity') AND new.to_id IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER involvement_link_ad AFTER DELETE ON links BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES (old.from_type, old.from_id);
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT old.to_type, old.to_id
    WHERE old.from_type IN ('person', 'identity') AND old.to_id IS NOT NULL;
END;--> statement-breakpoint
-- One identity links to one person, so a relink moves its rows and an unlink drops them. A new link queues
-- what the identity already took part in; a mention of it in an older message waits for `store reindex`.
CREATE TRIGGER involvement_identity_link_ai AFTER INSERT ON identity_links BEGIN
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'message', id FROM messages WHERE sender_identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'chat', chat_id FROM chat_members WHERE identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'meeting', meeting_id FROM meeting_participants WHERE identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', id FROM emails WHERE from_identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', email_id FROM email_recipients WHERE identity_id = new.identity_id;
  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT from_type, from_id FROM links WHERE to_type = 'identity' AND to_id = new.identity_id;
END;--> statement-breakpoint
CREATE TRIGGER involvement_identity_link_au AFTER UPDATE OF person_id ON identity_links WHEN old.person_id IS NOT new.person_id BEGIN
  UPDATE involvements SET person_id = new.person_id WHERE identity_id = new.identity_id;
END;--> statement-breakpoint
CREATE TRIGGER involvement_identity_link_ad AFTER DELETE ON identity_links BEGIN
  DELETE FROM involvements WHERE identity_id = old.identity_id;
END;--> statement-breakpoint
-- A conversation's chunk is a `chunks` row whose message range is in `chunk_messages`: deleting a message
-- cascades to the range, and the range takes its chunk with it, as a conversation takes all of its chunks.
CREATE TRIGGER chunk_messages_ad AFTER DELETE ON chunk_messages BEGIN
  DELETE FROM chunks WHERE id = old.chunk_id;
END;--> statement-breakpoint
CREATE TRIGGER conversation_ad AFTER DELETE ON conversations BEGIN
  DELETE FROM chunks WHERE chunkable_type = 'conversation' AND chunkable_id = old.id;
END;--> statement-breakpoint
-- A conversation chunk copies its chat's scope and project so a search filters before it compares; these keep
-- the copies right when the chat, its account or its project link changes.
CREATE TRIGGER conversation_chunks_chat_scope AFTER UPDATE OF scope ON chats WHEN old.scope IS NOT new.scope BEGIN
  UPDATE chunks SET scope = coalesce(new.scope, (SELECT scope FROM accounts WHERE id = new.account_id))
    WHERE chunkable_type = 'conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id = new.id);
END;--> statement-breakpoint
CREATE TRIGGER conversation_chunks_account_scope AFTER UPDATE OF scope ON accounts WHEN old.scope IS NOT new.scope BEGIN
  UPDATE chunks SET scope = new.scope
    WHERE chunkable_type = 'conversation' AND chunkable_id IN (
      SELECT c.id FROM conversations c JOIN chats ch ON ch.id = c.chat_id WHERE ch.account_id = new.id AND ch.scope IS NULL);
END;--> statement-breakpoint
CREATE TRIGGER conversation_chunks_project_ai AFTER INSERT ON links
  WHEN new.from_type = 'chat' AND new.to_type = 'project' AND new.kind = 'member-of' BEGIN
  UPDATE chunks SET project_id = (SELECT to_id FROM links WHERE from_type = 'chat' AND from_id = new.from_id
      AND to_type = 'project' AND kind = 'member-of' AND confirmed = 1 ORDER BY id LIMIT 1)
    WHERE chunkable_type = 'conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id = new.from_id);
END;--> statement-breakpoint
CREATE TRIGGER conversation_chunks_project_au AFTER UPDATE ON links
  WHEN new.from_type = 'chat' AND new.to_type = 'project' AND new.kind = 'member-of' BEGIN
  UPDATE chunks SET project_id = (SELECT to_id FROM links WHERE from_type = 'chat' AND from_id = new.from_id
      AND to_type = 'project' AND kind = 'member-of' AND confirmed = 1 ORDER BY id LIMIT 1)
    WHERE chunkable_type = 'conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id = new.from_id);
END;--> statement-breakpoint
CREATE TRIGGER conversation_chunks_project_ad AFTER DELETE ON links
  WHEN old.from_type = 'chat' AND old.to_type = 'project' AND old.kind = 'member-of' BEGIN
  UPDATE chunks SET project_id = (SELECT to_id FROM links WHERE from_type = 'chat' AND from_id = old.from_id
      AND to_type = 'project' AND kind = 'member-of' AND confirmed = 1 ORDER BY id LIMIT 1)
    WHERE chunkable_type = 'conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id = old.from_id);
END;--> statement-breakpoint
-- A new file has nothing to fill: the words index is built at once. `analyzer` stays NULL until the first
-- drain claims it.
INSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)
  VALUES ('message_words', 0, 0, 0, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), NULL),
         ('message_stems', 0, 0, 0, 1, NULL, NULL),
         ('note_index', 0, 0, 0, 1, NULL, NULL),
         ('document_index', 0, 0, 0, 1, NULL, NULL),
         ('memory_index', 0, 0, 0, 1, NULL, NULL);--> statement-breakpoint
-- The actors a task names before any messenger has saved anyone: the owner, and the bots a rule and an
-- unnamed agent act as. A note about nothing in particular is about this owner row.
INSERT INTO persons (name, owner, created_at, updated_at)
  VALUES (NULL, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER));--> statement-breakpoint
INSERT INTO bots (name, kind, created_at, updated_at)
  VALUES ('rule', 'script', CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)),
         ('agent', 'agent', CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER));
