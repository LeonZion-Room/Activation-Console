-- 激活中心 Activation Console - D1 数据库结构
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS groups(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    remark TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    group_id INTEGER DEFAULT 0,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'running',
    is_activate INTEGER DEFAULT 1,
    client_ip TEXT DEFAULT '',
    last_check_at TEXT DEFAULT '',
    last_status TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS check_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_code TEXT,
    client_ip TEXT,
    result INTEGER,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS op_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator TEXT DEFAULT 'admin',
    action TEXT,
    detail TEXT,
    client_ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO settings(key,value) VALUES ('admin_user','admin');
INSERT OR IGNORE INTO settings(key,value) VALUES ('password_hash','146a7408aee94579bdb02642681666869fa0255dd6a85f811980f7056183e9bf');
INSERT OR IGNORE INTO settings(key,value) VALUES ('auth_key','XK-8e8790934c4492731c60fc45fea81914d84288e6998d256a');

INSERT OR IGNORE INTO groups(id,name,remark) VALUES (1,'默认分组','系统内置');
INSERT OR IGNORE INTO groups(id,name,remark) VALUES (2,'核心服务','重点保障');
INSERT OR IGNORE INTO projects(project_code,name,group_id,description,is_activate,status) VALUES ('svc-backup','每日备份服务',2,'数据库与文件增量备份',1,'running');
INSERT OR IGNORE INTO projects(project_code,name,group_id,description,is_activate,status) VALUES ('svc-monitor','主机监控探针',2,'CPU/内存/磁盘采集上报',1,'running');
INSERT OR IGNORE INTO projects(project_code,name,group_id,description,is_activate,status) VALUES ('svc-sync','文件同步程序',1,'NAS 数据同步',0,'stopped');