-- Users Table 
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role ENUM('seller', 'buyer', 'admin') DEFAULT 'seller',
  email_is_verified BOOLEAN NOT NULL DEFAULT TRUE,
  email_verification_token VARCHAR(128) NULL,
  password_reset_token_hash VARCHAR(128) NULL,
  password_reset_expires_at DATETIME NULL,
  google_sub VARCHAR(255) NULL,
  is_2fa_enabled BOOLEAN DEFAULT FALSE,
  twofa_secret VARCHAR(255) NULL,
  notify_order_received BOOLEAN DEFAULT TRUE,
  notify_payment_received BOOLEAN DEFAULT TRUE,
  notify_feedback_received BOOLEAN DEFAULT TRUE,
  notify_admin_message BOOLEAN DEFAULT TRUE,
  notify_product_approved BOOLEAN DEFAULT TRUE,
  preferred_theme ENUM('light', 'dark') DEFAULT 'light',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) AUTO_INCREMENT = 100;

-- Application Settings Table
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Application Settings - Default Values
-- NOTE: Update these settings in the admin panel. File paths should use relative or URL-based paths, not Windows-specific paths.
INSERT IGNORE INTO app_settings (setting_key, setting_value)
VALUES
  -- Commission & Platform Fees
  ('platform_commission_percent', '1'),
  ('platform_commission_fixed', '0'),
  ('promotion_commission_percent', '5'),
  ('vat_shipping_rate', '0.25'),
  -- Email Configuration (update in admin panel)
  ('email_address', ''),
  ('email_company_name', ''),
  ('email_company_address', ''),
  ('email_company_logo_url', ''),
  ('email_use_test_receiver', 'false'),
  ('email_test_receiver', ''),
  -- Company Information
  ('company_organization_number', ''),
  -- PostNord Shipping Configuration
  ('postnord_customer_number', ''),
  ('postnord_debug_logs', 'false'),
  ('postnord_use_portal_pricing', 'false'),
  ('postnord_enable_transit_time', 'false'),
  -- OAuth & Third-party Services
  ('google_client_id', '');

-- User Profiles Table
CREATE TABLE IF NOT EXISTS profiles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  street VARCHAR(255),
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100),
  zip VARCHAR(10),
  phone_extension VARCHAR(10),
  phone VARCHAR(20),
  profile_type ENUM('private', 'company') DEFAULT 'private',
  personal_id_number VARCHAR(50),
  profile_picture_url VARCHAR(2000),
  display_name VARCHAR(255) NULL, 
  -- Company info
  company_name VARCHAR(255),
  company_org_number VARCHAR(100),
  company_vat_number VARCHAR(100),
  company_address VARCHAR(255),
  -- Admin verification
  status ENUM('pending', 'verified', 'blocked', 'rejected') DEFAULT 'pending',
  status_reason TEXT NULL,
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_profiles_user (user_id)
) AUTO_INCREMENT = 100;

-- Bank Accounts Table
CREATE TABLE IF NOT EXISTS bank_accounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  account_country VARCHAR(100) NOT NULL,
  account_holder_type ENUM('private', 'company') NOT NULL,
  routing_code VARCHAR(100) NULL,
  account_number_iban VARCHAR(100) NOT NULL,
  company_bank_type ENUM('bankgiro', 'plusgiro') NULL,
  bank_name VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bank_accounts_user (user_id),
  INDEX idx_bank_accounts_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) AUTO_INCREMENT = 100;


-- Products Table (Parent - Main Product Info)
CREATE TABLE products (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  seller_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  subtitle VARCHAR(255),
  description TEXT,
  category VARCHAR(100) NOT NULL,
  brand VARCHAR(100),
  sku VARCHAR(100) UNIQUE,
  age_category VARCHAR(100),
  item_condition ENUM('new', 'used') DEFAULT 'new',
  tax_class VARCHAR(50) DEFAULT 'standard',
  approval_status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  rejection_message TEXT NULL,
  is_promoted BOOLEAN DEFAULT FALSE,
  main_image_url VARCHAR(500),
  status ENUM('active', 'inactive', 'out_of_stock') DEFAULT 'active',
  type ENUM('digital', 'physical') DEFAULT 'physical',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_products_seller (seller_id),
  INDEX idx_products_category (category),
  INDEX idx_products_status (status)
) AUTO_INCREMENT = 100;

-- Product Variants Table (Children - Individual Variants with their own specifications)
CREATE TABLE product_variants (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id INT UNSIGNED NOT NULL,
  variant_name VARCHAR(100) NOT NULL,
  variant_value VARCHAR(255) NOT NULL,
  sku VARCHAR(100) UNIQUE,
  price DECIMAL(10,2) NOT NULL,
  discount_price DECIMAL(10,2) DEFAULT NULL,
  stock_quantity INT UNSIGNED NOT NULL DEFAULT 0,
  length_cm DECIMAL(10,2),
  width_cm DECIMAL(10,2),
  height_cm DECIMAL(10,2),
  weight_kg DECIMAL(10,2),
  
  type ENUM('digital', 'physical') DEFAULT 'physical',
  image_url VARCHAR(500),
  file_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE KEY uq_variant_sku (sku),
  UNIQUE KEY uq_variant_attr (product_id, variant_name, variant_value),
  INDEX idx_variant_product (product_id),
  INDEX idx_variant_type (type)
) AUTO_INCREMENT = 100;

-- Customers Table
CREATE TABLE IF NOT EXISTS customers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  
  -- Billing Address
  billing_street VARCHAR(255),
  billing_city VARCHAR(100),
  billing_state VARCHAR(100),
  billing_zip VARCHAR(20),
  billing_country VARCHAR(100),
  
  -- Shipping Address
  shipping_street VARCHAR(255),
  shipping_city VARCHAR(100),
  shipping_state VARCHAR(100),
  shipping_zip VARCHAR(20),
  shipping_country VARCHAR(100),
  
  date_joined TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_spend DECIMAL(12,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_customers_email (email),
  INDEX idx_customers_date (date_joined)
) AUTO_INCREMENT = 100;

-- Product Images Table
CREATE TABLE product_images (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id INT UNSIGNED NOT NULL,
  image_url VARCHAR(500) NOT NULL,
  is_main BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) AUTO_INCREMENT = 100;


-- Sales Table (Orders)
CREATE TABLE sales (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(50) UNIQUE NOT NULL,
    group_order_id VARCHAR(50) NOT NULL,           -- ← shared across all sellers in one checkout
    customer_id INT UNSIGNED NOT NULL,
    seller_id INT UNSIGNED NOT NULL,
    order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    order_status ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'returned') DEFAULT 'pending',
    payout_status ENUM('unpaid', 'paid') DEFAULT 'unpaid',
    status_reason TEXT NULL,
    payout_payment_date DATETIME NULL,
    payout_reference VARCHAR(120) NULL,
    payment_intent VARCHAR(255) NULL,
    tax_amount DECIMAL(12,2) DEFAULT 0,
    grand_total DECIMAL(12,2) NOT NULL,
    commission_amount DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_order_customer (customer_id),
    INDEX idx_order_seller (seller_id),
    INDEX idx_order_date (order_date),
    INDEX idx_order_group (group_order_id)          -- ← index for fast group lookups
) AUTO_INCREMENT = 100;

-- Sale Items Table (Order Line Items)
CREATE TABLE IF NOT EXISTS sale_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sale_id INT UNSIGNED NOT NULL,
    product_type ENUM('item', 'shipment') DEFAULT 'item',
    product_id INT UNSIGNED,
    product_name VARCHAR(255) NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    tax_amount DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    INDEX idx_sale_items_sale (sale_id),
    INDEX idx_sale_items_product (product_id)
) AUTO_INCREMENT = 100;

-- Payment Methods Table
CREATE TABLE IF NOT EXISTS payment_methods (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  provider VARCHAR(50) DEFAULT 'stripe',
  payment_method_id VARCHAR(255) NOT NULL,
  customer_id VARCHAR(255),
  card_brand VARCHAR(50),
  card_last4 VARCHAR(4),
  exp_month TINYINT,
  exp_year SMALLINT,
  cardholder_name VARCHAR(255),
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_payment_method_id (payment_method_id),
  INDEX idx_payment_methods_user (user_id),
  INDEX idx_payment_methods_default (user_id, is_default),
  INDEX idx_payment_methods_customer (customer_id)
) AUTO_INCREMENT = 100;

-- Product Reviews Table
CREATE TABLE product_reviews (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  rating TINYINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(255),
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_product_user (product_id, user_id)
) AUTO_INCREMENT = 100;

-- Website Reviews Table
CREATE TABLE IF NOT EXISTS website_reviews (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  rating TINYINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(255),
  review TEXT NOT NULL,
  is_approved BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_website_reviews_rating (rating),
  INDEX idx_website_reviews_approved (is_approved),
  INDEX idx_website_reviews_created_at (created_at)
) AUTO_INCREMENT = 100;

-- Shipment Policies Table (Seller's shipping fees by country)
CREATE TABLE IF NOT EXISTS shipment_policies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  seller_id INT UNSIGNED NOT NULL,
  country VARCHAR(100) NOT NULL,
  fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  vat_rate DECIMAL(5,2) NOT NULL DEFAULT 25,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_seller_country (seller_id, country),
  INDEX idx_shipment_seller (seller_id)
) AUTO_INCREMENT = 100;


-- Seller Payouts Table
CREATE TABLE IF NOT EXISTS payouts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bank_reference VARCHAR(255) NOT NULL,
  seller_id INT UNSIGNED NOT NULL,
  order_ids TEXT NOT NULL, -- Comma-separated order IDs
  payment_date DATETIME NOT NULL,
  payment_amount DECIMAL(12,2) NOT NULL,
  payment_reference VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_payouts_seller (seller_id),
  INDEX idx_payouts_reference (payment_reference)
);

-- Newsletter Subscribers Table
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  source VARCHAR(50) DEFAULT 'footer',
  subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_newsletter_email (email),
  INDEX idx_newsletter_active (is_active),
  INDEX idx_newsletter_subscribed_at (subscribed_at)
) AUTO_INCREMENT = 100;

