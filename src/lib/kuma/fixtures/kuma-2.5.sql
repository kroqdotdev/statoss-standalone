-- The tables import-kuma reads, from a database made by louislam/uptime-kuma:2 (Uptime
-- Kuma 2.5.5): monitors, notifications, two status pages and two
-- maintenance windows added through Kuma's own socket.io API, as its UI
-- does, then dumped. Columns left at their default are not written.

CREATE TABLE [user](
  [id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, 
  [username] VARCHAR(255) NOT NULL UNIQUE, 
  [password] VARCHAR(255), 
  [active] BOOLEAN NOT NULL DEFAULT 1, 
  [timezone] VARCHAR(150), twofa_secret VARCHAR(64), twofa_status BOOLEAN default 0 NOT NULL, twofa_last_token VARCHAR(6));

CREATE TABLE docker_host (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	user_id INT NOT NULL,
	docker_daemon VARCHAR(255),
	docker_type VARCHAR(255),
	name VARCHAR(255)
);

CREATE TABLE "proxy" (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `user_id` INT NOT NULL, `protocol` VARCHAR(10) NOT NULL, `host` VARCHAR(255) NOT NULL, `port` integer, `auth` BOOLEAN NOT NULL, `username` VARCHAR(255) NULL, `password` VARCHAR(255) NULL, `active` BOOLEAN NOT NULL DEFAULT 1, `default` BOOLEAN NOT NULL DEFAULT 0, `created_date` DATETIME NOT NULL DEFAULT (DATETIME('now')));

CREATE TABLE `remote_browser` (`id` integer not null primary key autoincrement, `name` varchar(255) not null, `url` varchar(255) not null, `user_id` integer);

CREATE TABLE "monitor" (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `name` VARCHAR(150), `active` BOOLEAN NOT NULL DEFAULT 1, `user_id` INTEGER REFERENCES `user` ON DELETE SET NULL ON UPDATE CASCADE, `interval` INTEGER NOT NULL DEFAULT 20, `url` TEXT, `type` VARCHAR(20), `weight` INTEGER DEFAULT 2000, `hostname` VARCHAR(255), `port` INTEGER, `created_date` DATETIME NOT NULL DEFAULT (DATETIME('now')), `keyword` VARCHAR(255), `maxretries` INTEGER NOT NULL DEFAULT 0, `ignore_tls` BOOLEAN NOT NULL DEFAULT 0, `upside_down` BOOLEAN NOT NULL DEFAULT 0, `maxredirects` INTEGER NOT NULL DEFAULT 10, `accepted_statuscodes_json` TEXT NOT NULL DEFAULT '["200-299"]', `dns_resolve_type` VARCHAR(5), `dns_resolve_server` VARCHAR(255), `dns_last_result` text, `retry_interval` INTEGER NOT NULL DEFAULT 0, `push_token` varchar(32), `method` TEXT NOT NULL DEFAULT 'GET', `body` TEXT DEFAULT null, `headers` TEXT DEFAULT null, `basic_auth_user` TEXT DEFAULT null, `basic_auth_pass` TEXT DEFAULT null, `docker_host` INTEGER REFERENCES `docker_host` (`id`), `docker_container` VARCHAR(255), `proxy_id` INTEGER REFERENCES `proxy` (`id`), `expiry_notification` BOOLEAN DEFAULT 1, `mqtt_topic` TEXT, `mqtt_success_message` VARCHAR(255), `mqtt_username` VARCHAR(255), `mqtt_password` VARCHAR(255), `database_connection_string` VARCHAR(2000), `database_query` TEXT, `auth_method` VARCHAR(250), `auth_domain` TEXT, `auth_workstation` TEXT, `grpc_url` VARCHAR(255) DEFAULT null, `grpc_protobuf` TEXT DEFAULT null, `grpc_body` TEXT DEFAULT null, `grpc_metadata` TEXT DEFAULT null, `grpc_method` VARCHAR(255) DEFAULT null, `grpc_service_name` VARCHAR(255) DEFAULT null, `grpc_enable_tls` BOOLEAN NOT NULL DEFAULT 0, `radius_username` VARCHAR(255), `radius_password` VARCHAR(255), `radius_calling_station_id` VARCHAR(50), `radius_called_station_id` VARCHAR(50), `radius_secret` VARCHAR(255), `resend_interval` INTEGER NOT NULL DEFAULT 0, `packet_size` INTEGER NOT NULL DEFAULT 56, `game` VARCHAR(255), `http_body_encoding` VARCHAR(25), `description` TEXT DEFAULT null, `tls_ca` TEXT DEFAULT null, `tls_cert` TEXT DEFAULT null, `tls_key` TEXT DEFAULT null, `parent` INTEGER REFERENCES `monitor` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, `invert_keyword` BOOLEAN NOT NULL DEFAULT 0, `json_path` TEXT, `expected_value` VARCHAR(255), `kafka_producer_topic` VARCHAR(255), `kafka_producer_brokers` TEXT, `kafka_producer_sasl_options` TEXT, `kafka_producer_message` TEXT, `oauth_client_id` TEXT DEFAULT null, `oauth_client_secret` TEXT DEFAULT null, `oauth_token_url` TEXT DEFAULT null, `oauth_scopes` TEXT DEFAULT null, `oauth_auth_method` TEXT DEFAULT null, `timeout` DOUBLE NOT NULL DEFAULT 0, `gamedig_given_port_only` BOOLEAN NOT NULL DEFAULT 1, `kafka_producer_ssl` BOOLEAN NOT NULL DEFAULT 0, `kafka_producer_allow_auto_topic_creation` BOOLEAN NOT NULL DEFAULT 0, `mqtt_check_type` varchar(255) NOT NULL DEFAULT 'keyword', `remote_browser` integer NULL DEFAULT null, `snmp_oid` varchar(255) DEFAULT null, `snmp_version` text CHECK (`snmp_version` in('1' , '2c' , '3')) DEFAULT '2c', `json_path_operator` varchar(255) DEFAULT null, `cache_bust` boolean NOT NULL DEFAULT '0', `conditions` text NOT NULL DEFAULT '[]', `rabbitmq_nodes` text, `rabbitmq_username` varchar(255), `rabbitmq_password` varchar(255), `smtp_security` varchar(255) DEFAULT null, `ws_ignore_sec_websocket_accept_header` boolean NOT NULL DEFAULT '0', `ws_subprotocol` varchar(255) NOT NULL DEFAULT '', `ping_count` integer NOT NULL DEFAULT '1', `ping_numeric` boolean NOT NULL DEFAULT '1', `ping_per_request_timeout` integer NOT NULL DEFAULT '2', `ip_family` varchar(4) DEFAULT null, `manual_status` integer, `oauth_audience` varchar(255) NULL DEFAULT null, `mqtt_websocket_path` varchar(255) NULL, `domain_expiry_notification` boolean DEFAULT '0', `save_response` boolean NOT NULL DEFAULT '0', `save_error_response` boolean NOT NULL DEFAULT '1', `response_max_length` integer NOT NULL DEFAULT '1024', `system_service_name` varchar(255), `subtype` varchar(10) NULL, `location` varchar(255) NULL, `protocol` varchar(20) NULL, `snmp_v3_username` varchar(255), `expected_tls_alert` varchar(50) DEFAULT null, `retry_only_on_status_code_failure` boolean NOT NULL DEFAULT '0', `screenshot_delay` integer NOT NULL DEFAULT '0', `ntp_stratum_threshold` integer default '5', `ntp_time_offset_threshold` integer default '1000', `ntp_root_dispersion_threshold` integer default '500', `bearer_token` text default null, `gamedig_token` text default null, `ssh_username` varchar(255), `ssh_password` varchar(255), `sftp_path` varchar(255), `ssh_private_key` text, `ssh_passphrase` varchar(255), `ssh_auth_method` varchar(255) default 'password', FOREIGN KEY (`remote_browser`) REFERENCES `remote_browser` (`id`));
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (1, 'Backend', 60, 'https://', 'group', 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (2, 'Website', 60, 'https://example.com', 'http', 'A', '', 60, '', '', '', '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "keyword", "dns_resolve_type", "dns_resolve_server", "retry_interval", "method", "body", "headers", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "parent", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (3, 'API', 60, 'https://api.example.com/health', 'keyword', 'ok', 'A', '', 60, 'POST', '{"ping": true}', '{"X-Api-Key": "secret-key-1", "Accept": "application/json"}', '', '', '', 0, '', '', '', '', 'json', 1, '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "keyword", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "parent", "invert_keyword", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (4, 'No errors', 60, 'https://example.com/status', 'keyword', 'error', 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', 1, 1, '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "json_path", "expected_value", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "json_path_operator", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (5, 'JSON health', 60, 'https://api.example.com/v1/health', 'json-query', 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', 'status', 'ok', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '==', '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "maxredirects", "accepted_statuscodes_json", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (6, 'Old domain', 60, 'http://old.example.com', 'http', 0, '["301"]', 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "auth_method", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (7, 'Admin', 60, 'https://admin.example.com', 'http', 'A', '', 60, 'kuma', 'pa55', '', 0, '', '', '', '', 'basic', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (8, 'Database', 120, 'https://', 'port', 'db.example.com', 5432, 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (9, 'Gateway', 30, 'https://', 'ping', 'gw.example.com', 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (10, 'Mail records', 60, 'https://', 'dns', 'example.com', 53, 'MX', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (11, 'CAA', 60, 'https://', 'dns', 'example.com', 53, 'CAA', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "push_token", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (12, 'Nightly backup', 86400, 'https://', 'push', 'A', '', 60, 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56', '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "push_token", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (13, 'Cron', 300, 'https://', 'push', 'A', '', 60, 'abc', '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (14, 'Broker', 60, 'https://', 'mqtt', 'mqtt.example.com', 1883, 'A', '', 60, '', '', '', 0, 'health', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "active", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (15, 'Old API', 0, 60, 'https://old-api.example.com', 'http', 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (16, 'Mobile app', 60, 'https://', 'manual', 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', '', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "auth_method", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (17, 'Private API', 60, 'https://private.example.com', 'http', 'A', '', 60, '', '', '', 0, '', '', '', '', 'bearer', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[]', '', '', '', 1, '', 'world', 'bearer-secret', '');
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout", "conditions", "rabbitmq_nodes", "rabbitmq_username", "rabbitmq_password", "mqtt_websocket_path", "domain_expiry_notification", "system_service_name", "location", "bearer_token", "gamedig_token") VALUES (18, 'Apex A', 60, 'https://', 'dns', 'example.org', 53, 'A', '', 60, '', '', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48, '[{"type":"expression","variable":"record","operator":"contains","value":"93.184","andOr":"and"}]', '[]', '', '', '', 1, '', 'world', '', '');

CREATE TABLE [notification](
  [id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, 
  [name] VARCHAR(255), 
  [active] BOOLEAN NOT NULL DEFAULT 1, 
  [user_id] INTEGER NOT NULL, is_default BOOLEAN default 0 NOT NULL, config TEXT);
INSERT INTO "notification" ("id", "name", "user_id", "config") VALUES (1, 'Ops email', 1, '{"isDefault":false,"applyExisting":false,"name":"Ops email","type":"smtp","smtpHost":"smtp.example.com","smtpPort":587,"smtpSecure":false,"smtpUsername":"alerts@example.com","smtpPassword":"smtp-secret-pass","smtpFrom":"Kuma <alerts@example.com>","smtpTo":"ops@example.com, oncall@example.com"}');
INSERT INTO "notification" ("id", "name", "user_id", "config") VALUES (2, 'Team Slack', 1, '{"isDefault":false,"applyExisting":false,"name":"Team Slack","type":"slack","slackwebhookURL":"https://hooks.slack.com/services/T000/B000/SLACKSECRET"}');
INSERT INTO "notification" ("id", "name", "user_id", "config") VALUES (3, 'Discord', 1, '{"isDefault":false,"applyExisting":false,"name":"Discord","type":"discord","discordWebhookUrl":"https://discord.com/api/webhooks/123/DISCORDSECRET","discordUsername":"Kuma"}');
INSERT INTO "notification" ("id", "name", "user_id", "config") VALUES (4, 'n8n hook', 1, '{"isDefault":false,"applyExisting":false,"name":"n8n hook","type":"webhook","webhookURL":"https://n8n.example.com/webhook/abc123","webhookContentType":"json"}');
INSERT INTO "notification" ("id", "name", "user_id", "config") VALUES (5, 'PagerDuty', 1, '{"isDefault":false,"applyExisting":false,"name":"PagerDuty","type":"PagerDuty","pagerdutyIntegrationKey":"PDKEY123456","pagerdutyIntegrationUrl":"https://events.pagerduty.com/v2/enqueue","pagerdutyPriority":"critical"}');
INSERT INTO "notification" ("id", "name", "user_id", "config") VALUES (6, 'Opsgenie EU', 1, '{"isDefault":false,"applyExisting":false,"name":"Opsgenie EU","type":"Opsgenie","opsgenieApiKey":"OGKEY-123","opsgenieRegion":"eu","opsgeniePriority":2}');
INSERT INTO "notification" ("id", "name", "user_id", "config") VALUES (7, 'Phone', 1, '{"isDefault":false,"applyExisting":false,"name":"Phone","type":"ntfy","ntfyserverurl":"https://ntfy.sh","ntfytopic":"kuma-alerts","ntfyPriority":5,"ntfyAuthenticationMethod":"accessToken","ntfyaccesstoken":"tk_secret123"}');
INSERT INTO "notification" ("id", "name", "user_id", "config") VALUES (8, 'Telegram', 1, '{"isDefault":false,"applyExisting":false,"name":"Telegram","type":"telegram","telegramBotToken":"123:abc","telegramChatID":"42"}');

CREATE TABLE [monitor_notification](
  [id] INTEGER PRIMARY KEY NOT NULL, 
  [monitor_id] INTEGER NOT NULL REFERENCES [monitor]([id]) ON DELETE CASCADE ON UPDATE CASCADE, 
  [notification_id] INTEGER NOT NULL REFERENCES [notification]([id]) ON DELETE CASCADE ON UPDATE CASCADE);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (1, 2, 1);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (2, 2, 2);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (3, 3, 2);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (4, 3, 5);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (5, 4, 2);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (6, 5, 7);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (7, 8, 6);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (8, 9, 3);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (9, 10, 4);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (10, 12, 1);
INSERT INTO "monitor_notification" ("id", "monitor_id", "notification_id") VALUES (11, 14, 8);

CREATE TABLE "status_page" (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `slug` VARCHAR(255) NOT NULL UNIQUE, `title` VARCHAR(255) NOT NULL, `description` TEXT, `icon` VARCHAR(255) NOT NULL, `theme` VARCHAR(30) NOT NULL, `published` BOOLEAN NOT NULL DEFAULT 1, `search_engine_index` BOOLEAN NOT NULL DEFAULT 1, `show_tags` BOOLEAN NOT NULL DEFAULT 0, `password` VARCHAR, `created_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, `modified_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, `footer_text` TEXT, `custom_css` TEXT, `show_powered_by` BOOLEAN NOT NULL DEFAULT 1, `analytics_id` VARCHAR, `show_certificate_expiry` BOOLEAN NOT NULL DEFAULT 0, `auto_refresh_interval` integer DEFAULT '300', `analytics_script_url` varchar(255), `show_only_last_heartbeat` boolean NOT NULL DEFAULT '0', `rss_title` varchar(255), `analytics_type` varchar(255) null default null);
INSERT INTO "status_page" ("id", "slug", "title", "description", "icon", "theme", "footer_text", "custom_css") VALUES (1, 'example', 'Example', 'Everything Example runs.', '/icon.svg', 'dark', 'Footer', 'body {}');
INSERT INTO "status_page" ("id", "slug", "title", "description", "icon", "theme", "footer_text", "custom_css", "show_powered_by") VALUES (2, 'internal', 'Internal', '', '/icon.svg', 'light', '', '', 0);

CREATE TABLE [status_page_cname](
    [id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    [status_page_id] INTEGER NOT NULL REFERENCES [status_page]([id]) ON DELETE CASCADE ON UPDATE CASCADE,
    [domain] VARCHAR NOT NULL UNIQUE
);
INSERT INTO "status_page_cname" ("id", "status_page_id", "domain") VALUES (1, 1, 'status.example.com');

CREATE TABLE `group`
(
    id           INTEGER      not null
        constraint group_pk
            primary key autoincrement,
    name         VARCHAR(255) not null,
    created_date DATETIME              default (DATETIME('now')) not null,
    public       BOOLEAN               default 0 not null,
    active       BOOLEAN               default 1 not null,
    weight       BOOLEAN      NOT NULL DEFAULT 1000
, status_page_id INTEGER);
INSERT INTO "group" ("id", "name", "public", "weight", "status_page_id") VALUES (1, 'Services', 1, 1, 1);
INSERT INTO "group" ("id", "name", "public", "weight", "status_page_id") VALUES (2, 'Infrastructure', 1, 2, 1);
INSERT INTO "group" ("id", "name", "public", "weight", "status_page_id") VALUES (3, 'Jobs', 1, 1, 2);

CREATE TABLE [monitor_group]
(
    [id]         INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    [monitor_id] INTEGER                           NOT NULL REFERENCES [monitor] ([id]) ON DELETE CASCADE ON UPDATE CASCADE,
    [group_id]   INTEGER                           NOT NULL REFERENCES [group] ([id]) ON DELETE CASCADE ON UPDATE CASCADE,
    weight BOOLEAN NOT NULL DEFAULT 1000
, send_url BOOLEAN DEFAULT 0 NOT NULL, `custom_url` text);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (1, 2, 1, 1);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (2, 3, 1, 2);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (3, 5, 1, 3);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (4, 8, 2, 1);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (5, 9, 2, 2);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (6, 14, 2, 3);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (7, 16, 2, 4);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (8, 12, 3, 1);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (9, 1, 3, 2);

CREATE TABLE [maintenance] (
    [id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    [title] VARCHAR(150) NOT NULL,
    [description] TEXT NOT NULL,
    [user_id] INTEGER REFERENCES [user]([id]) ON DELETE SET NULL ON UPDATE CASCADE,
    [active] BOOLEAN NOT NULL DEFAULT 1,
    [strategy] VARCHAR(50) NOT NULL DEFAULT 'single',
    [start_date] DATETIME,
    [end_date] DATETIME,
    [start_time] TIME,
    [end_time] TIME,
    [weekdays] VARCHAR2(250) DEFAULT '[]',
    [days_of_month] TEXT DEFAULT '[]',
    [interval_day] INTEGER
, cron TEXT, timezone VARCHAR(255), duration INTEGER, `last_start_date` datetime);
INSERT INTO "maintenance" ("id", "title", "description", "start_date", "end_date", "interval_day", "timezone") VALUES (1, 'Database upgrade', 'Postgres 17.', '2030-10-10 02:00', '2030-10-10 04:00', 1, 'Europe/Copenhagen');
INSERT INTO "maintenance" ("id", "title", "description", "strategy", "start_time", "end_time", "weekdays", "interval_day", "cron", "timezone", "duration") VALUES (2, 'Weekly restart', '', 'recurring-weekday', '04:00', '04:30', '[7]', 1, '0 4 * * 7', 'UTC', 1800);

CREATE TABLE monitor_maintenance (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL,
    maintenance_id INTEGER NOT NULL,
    CONSTRAINT FK_maintenance FOREIGN KEY (maintenance_id) REFERENCES maintenance (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT FK_monitor FOREIGN KEY (monitor_id) REFERENCES monitor (id) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "monitor_maintenance" ("id", "monitor_id", "maintenance_id") VALUES (1, 8, 1);

CREATE TABLE maintenance_status_page (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    status_page_id INTEGER NOT NULL,
    maintenance_id INTEGER NOT NULL,
    CONSTRAINT FK_maintenance FOREIGN KEY (maintenance_id) REFERENCES maintenance (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT FK_status_page FOREIGN KEY (status_page_id) REFERENCES status_page (id) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "maintenance_status_page" ("id", "status_page_id", "maintenance_id") VALUES (1, 1, 2);

CREATE TABLE "setting"
(
    id INTEGER
        primary key autoincrement,
    key VARCHAR(200) not null
        unique,
    value TEXT,
    type VARCHAR(20)
);
INSERT INTO "setting" ("id", "key", "value", "type") VALUES (5, 'tlsExpiryNotifyDays', '[7,14,21]', 'general');
INSERT INTO "setting" ("id", "key", "value", "type") VALUES (7, 'domainExpiryNotifyDays', '[7,14,21]', 'general');

CREATE TABLE "domain_expiry" (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `last_check` datetime, `domain` varchar(255) NOT NULL, `expiry` datetime, `last_expiry_notification_sent` integer DEFAULT null);
INSERT INTO "domain_expiry" ("id", "domain", "expiry") VALUES (1, 'example.com', '2027-08-13 04:00:00.000');
INSERT INTO "domain_expiry" ("id", "domain", "expiry") VALUES (2, 'example.org', '2027-08-30 04:00:00.000');

CREATE TABLE incident
(
    id INTEGER not null
        constraint incident_pk
            primary key autoincrement,
    title VARCHAR(255) not null,
    content TEXT not null,
    style VARCHAR(30) default 'warning' not null,
    created_date DATETIME default (DATETIME('now')) not null,
    last_updated_date DATETIME,
    pin BOOLEAN default 1 not null,
    active BOOLEAN default 1 not null
, status_page_id INTEGER);

CREATE TABLE `knex_migrations` (`id` integer not null primary key autoincrement, `name` varchar(255), `batch` integer, `migration_time` datetime);
