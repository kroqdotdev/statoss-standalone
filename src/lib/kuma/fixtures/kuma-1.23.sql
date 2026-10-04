-- The tables import-kuma reads, from a database made by louislam/uptime-kuma:1 (Uptime
-- Kuma 1.23.17): monitors, notifications, two status pages and two
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

CREATE TABLE proxy (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    user_id INT NOT NULL,
    protocol VARCHAR(10) NOT NULL,
    host VARCHAR(255) NOT NULL,
    port SMALLINT NOT NULL,
    auth BOOLEAN NOT NULL,
    username VARCHAR(255) NULL,
    password VARCHAR(255) NULL,
    active BOOLEAN NOT NULL DEFAULT 1,
    'default' BOOLEAN NOT NULL DEFAULT 0,
    created_date DATETIME DEFAULT (DATETIME('now')) NOT NULL
);

CREATE TABLE "monitor" (
	id INTEGER not null primary key autoincrement,
	name VARCHAR(150),
	active BOOLEAN default 1 not null,
	user_id INTEGER references user on update cascade on delete
	set
		null,
		interval INTEGER default 20 not null,
		url TEXT,
		type VARCHAR(20),
		weight INTEGER default 2000,
		hostname VARCHAR(255),
		port INTEGER,
		created_date DATETIME default (DATETIME('now')) not null,
		keyword VARCHAR(255),
		maxretries INTEGER NOT NULL DEFAULT 0,
		ignore_tls BOOLEAN default 0 not null,
		upside_down BOOLEAN default 0 not null,
        maxredirects INTEGER default 10 not null,
        accepted_statuscodes_json TEXT default '["200-299"]' not null
, dns_resolve_type VARCHAR(5), dns_resolve_server VARCHAR(255), dns_last_result VARCHAR(255), retry_interval INTEGER default 0 not null, push_token VARCHAR(20) DEFAULT NULL, method TEXT default 'GET' not null, body TEXT default null, headers TEXT default null, basic_auth_user TEXT default null, basic_auth_pass TEXT default null, docker_host INTEGER REFERENCES docker_host(id), docker_container VARCHAR(255), proxy_id INTEGER REFERENCES proxy(id), expiry_notification BOOLEAN default 1, mqtt_topic TEXT, mqtt_success_message VARCHAR(255), mqtt_username VARCHAR(255), mqtt_password VARCHAR(255), database_connection_string VARCHAR(2000), database_query TEXT, auth_method VARCHAR(250), auth_domain TEXT, auth_workstation TEXT, grpc_url VARCHAR(255) default null, grpc_protobuf TEXT default null, grpc_body TEXT default null, grpc_metadata TEXT default null, grpc_method VARCHAR(255) default null, grpc_service_name VARCHAR(255) default null, grpc_enable_tls BOOLEAN default 0 not null, radius_username VARCHAR(255), radius_password VARCHAR(255), radius_calling_station_id VARCHAR(50), radius_called_station_id VARCHAR(50), radius_secret VARCHAR(255), resend_interval INTEGER default 0 not null, packet_size INTEGER DEFAULT 56 NOT NULL, game VARCHAR(255), http_body_encoding VARCHAR(25), description TEXT default null, tls_ca TEXT default null, tls_cert TEXT default null, tls_key TEXT default null, parent INTEGER REFERENCES [monitor] ([id]) ON DELETE SET NULL ON UPDATE CASCADE, invert_keyword BOOLEAN default 0 not null, json_path TEXT, expected_value VARCHAR(255), kafka_producer_topic VARCHAR(255), kafka_producer_brokers TEXT, kafka_producer_sasl_options TEXT, kafka_producer_message TEXT, oauth_client_id TEXT default null, oauth_client_secret TEXT default null, oauth_token_url TEXT default null, oauth_scopes TEXT default null, oauth_auth_method TEXT default null, timeout DOUBLE default 0 not null, gamedig_given_port_only BOOLEAN default 1 not null, kafka_producer_ssl BOOLEAN default 0 NOT NULL, kafka_producer_allow_auto_topic_creation BOOLEAN default 0 NOT NULL);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (1, 'Backend', 60, 'https://', 'group', 'A', '1.1.1.1', 60, '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (2, 'Website', 60, 'https://example.com', 'http', 'A', '1.1.1.1', 60, '', '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "keyword", "dns_resolve_type", "dns_resolve_server", "retry_interval", "method", "body", "headers", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "parent", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (3, 'API', 60, 'https://api.example.com/health', 'keyword', 'ok', 'A', '1.1.1.1', 60, 'POST', '{"ping": true}', '{"X-Api-Key": "secret-key-1", "Accept": "application/json"}', '', 0, '', '', '', '', 'json', 1, '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "keyword", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "parent", "invert_keyword", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (4, 'No errors', 60, 'https://example.com/status', 'keyword', 'error', 'A', '1.1.1.1', 60, '', 0, '', '', '', '', 'json', 1, 1, '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "json_path", "expected_value", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (5, 'JSON health', 60, 'https://api.example.com/v1/health', 'json-query', 'A', '1.1.1.1', 60, '', 0, '', '', '', '', 'json', 'status', 'ok', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "maxredirects", "accepted_statuscodes_json", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (6, 'Old domain', 60, 'http://old.example.com', 'http', 0, '["301"]', 'A', '1.1.1.1', 60, '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "basic_auth_user", "basic_auth_pass", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "auth_method", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (7, 'Admin', 60, 'https://admin.example.com', 'http', 'A', '1.1.1.1', 60, 'kuma', 'pa55', '', 0, '', '', '', '', 'basic', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (8, 'Database', 120, 'https://', 'port', 'db.example.com', 5432, 'A', '1.1.1.1', 60, '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (9, 'Gateway', 30, 'https://', 'ping', 'gw.example.com', 'A', '1.1.1.1', 60, '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "dns_last_result", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (10, 'Mail records', 60, 'https://', 'dns', 'example.com', 53, 'MX', '1.1.1.1', 'Hostname:  - Priority: 0 ', 60, '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (11, 'CAA', 60, 'https://', 'dns', 'example.com', 53, 'CAA', '1.1.1.1', 60, '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "push_token", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (12, 'Nightly backup', 86400, 'https://', 'push', 'A', '1.1.1.1', 60, 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "push_token", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (13, 'Cron', 300, 'https://', 'push', 'A', '1.1.1.1', 60, 'abc', '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "interval", "url", "type", "hostname", "port", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (14, 'Broker', 60, 'https://', 'mqtt', 'mqtt.example.com', 1883, 'A', '1.1.1.1', 60, '', 0, 'health', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);
INSERT INTO "monitor" ("id", "name", "active", "interval", "url", "type", "dns_resolve_type", "dns_resolve_server", "retry_interval", "docker_container", "expiry_notification", "mqtt_topic", "mqtt_success_message", "mqtt_username", "mqtt_password", "http_body_encoding", "kafka_producer_brokers", "kafka_producer_sasl_options", "oauth_auth_method", "timeout") VALUES (15, 'Old API', 0, 60, 'https://old-api.example.com', 'http', 'A', '1.1.1.1', 60, '', 0, '', '', '', '', 'json', '[]', '{"mechanism":"None"}', 'client_secret_basic', 48);

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

CREATE TABLE [status_page](
    [id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    [slug] VARCHAR(255) NOT NULL UNIQUE,
    [title] VARCHAR(255) NOT NULL,
    [description] TEXT,
    [icon] VARCHAR(255) NOT NULL,
    [theme] VARCHAR(30) NOT NULL,
    [published] BOOLEAN NOT NULL DEFAULT 1,
    [search_engine_index] BOOLEAN NOT NULL DEFAULT 1,
    [show_tags] BOOLEAN NOT NULL DEFAULT 0,
    [password] VARCHAR,
    [created_date] DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    [modified_date] DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
, footer_text TEXT, custom_css TEXT, show_powered_by BOOLEAN NOT NULL DEFAULT 1, google_analytics_tag_id VARCHAR, show_certificate_expiry BOOLEAN default 0 NOT NULL);
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
, send_url BOOLEAN DEFAULT 0 NOT NULL);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (1, 2, 1, 1);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (2, 3, 1, 2);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (3, 5, 1, 3);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (4, 8, 2, 1);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (5, 9, 2, 2);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (6, 14, 2, 3);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (7, 12, 3, 1);
INSERT INTO "monitor_group" ("id", "monitor_id", "group_id", "weight") VALUES (8, 1, 3, 2);

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
, cron TEXT, timezone VARCHAR(255), duration INTEGER);
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
INSERT INTO "setting" ("id", "key", "value", "type") VALUES (4, 'tlsExpiryNotifyDays', '[7,14,21]', 'general');

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
