-- bootstrap.sql
-- Run this ONCE when provisioning the database server.
-- Do NOT run this during normal app startup.
-- It requires a MySQL root/admin account.
--
-- Usage (as root):
--   mysql -u root -p < bootstrap.sql

CREATE USER IF NOT EXISTS 'testdb'@'localhost' IDENTIFIED BY 'testdb';
CREATE DATABASE IF NOT EXISTS testdb;
GRANT ALL PRIVILEGES ON testdb.* TO 'testdb'@'localhost';
FLUSH PRIVILEGES;
