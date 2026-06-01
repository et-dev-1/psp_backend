import fs from 'fs'
import path from 'path'
const nodemailer = require('nodemailer')
import { SMTP, EMAIL, CLIENT_URL, BACKEND_PUBLIC_BASE_URL } from '../config'

const resolveTemplatePath = (filename: string): string => {
  const candidates = [
    path.join(__dirname, filename),
    path.join(__dirname, '..', '..', 'email', filename),
    path.join(process.cwd(), 'email', filename),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`Email template not found: ${filename}. Checked: ${candidates.join(', ')}`)
}

const getEmailBaseUrl = (): string => {
  const clientBase = String(CLIENT_URL || '').replace(/\/+$/, '')
  if (clientBase) return clientBase

  const backendBase = String(BACKEND_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (backendBase) return backendBase

  return ''
}

const normalizeEmailUrl = (value: string): string => {
  const raw = String(value || '').trim()
  if (!raw) return '#'

  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(raw) || raw.startsWith('mailto:') || raw.startsWith('tel:')) {
    return raw
  }

  const base = getEmailBaseUrl()
  if (!base) {
    return raw.startsWith('/') ? raw : `/${raw}`
  }

  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`
}

// Do NOT capture host/port/secure at module load — read live from SMTP object at call time

type EmailAccountInfo = { email_address: string; plain_password: string }
type EmailAccountResolver = (purpose: string) => Promise<EmailAccountInfo | null>
type SmtpSettingsResolver = () => Promise<{ host: string; port: number; secure: boolean } | null>
type SmtpDefaultCredentialsResolver = () => Promise<{ user: string; pass: string } | null>

let emailAccountResolver: EmailAccountResolver | null = null
let smtpSettingsResolver: SmtpSettingsResolver | null = null
let smtpDefaultCredentialsResolver: SmtpDefaultCredentialsResolver | null = null

export const setEmailAccountResolver = (fn: EmailAccountResolver): void => {
  emailAccountResolver = fn
}

export const setSmtpSettingsResolver = (fn: SmtpSettingsResolver): void => {
  smtpSettingsResolver = fn
}

export const setSmtpDefaultCredentialsResolver = (fn: SmtpDefaultCredentialsResolver): void => {
  smtpDefaultCredentialsResolver = fn
}

const stripHtml = (value: string): string => {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

const invoiceTemplatePath = resolveTemplatePath('InvoiceCustomer.hbs')
let invoiceTemplateCache: string | null = null

const getInvoiceTemplate = (): string => {
  if (invoiceTemplateCache) return invoiceTemplateCache
  invoiceTemplateCache = fs.readFileSync(invoiceTemplatePath, 'utf8')
  return invoiceTemplateCache
}

const digitalProductTemplatePath = resolveTemplatePath('DigitalProduct.hbs')
let digitalProductTemplateCache: string | null = null

const getDigitalProductTemplate = (): string => {
  if (digitalProductTemplateCache) return digitalProductTemplateCache
  digitalProductTemplateCache = fs.readFileSync(digitalProductTemplatePath, 'utf8')
  return digitalProductTemplateCache
}

const shipmentTemplatePath = resolveTemplatePath('Shipment.hbs')
let shipmentTemplateCache: string | null = null

const getShipmentTemplate = (): string => {
  if (shipmentTemplateCache) return shipmentTemplateCache
  shipmentTemplateCache = fs.readFileSync(shipmentTemplatePath, 'utf8')
  return shipmentTemplateCache
}

const sellerPayoutReceiptTemplatePath = resolveTemplatePath('SellerPayoutReceipt.hbs')
let sellerPayoutReceiptTemplateCache: string | null = null

const getSellerPayoutReceiptTemplate = (): string => {
  if (sellerPayoutReceiptTemplateCache) return sellerPayoutReceiptTemplateCache
  sellerPayoutReceiptTemplateCache = fs.readFileSync(sellerPayoutReceiptTemplatePath, 'utf8')
  return sellerPayoutReceiptTemplateCache
}

const sellerOrderReceivedTemplatePath = resolveTemplatePath('SellerOrderReceived.hbs')
let sellerOrderReceivedTemplateCache: string | null = null

const getSellerOrderReceivedTemplate = (): string => {
  if (sellerOrderReceivedTemplateCache) return sellerOrderReceivedTemplateCache
  sellerOrderReceivedTemplateCache = fs.readFileSync(sellerOrderReceivedTemplatePath, 'utf8')
  return sellerOrderReceivedTemplateCache
}

const emailFooterTemplatePath = resolveTemplatePath('EmailFooter.hbs')
let emailFooterTemplateCache: string | null = null

const getEmailFooterTemplate = (): string => {
  if (emailFooterTemplateCache) return emailFooterTemplateCache
  emailFooterTemplateCache = fs.readFileSync(emailFooterTemplatePath, 'utf8')
  return emailFooterTemplateCache
}

const sellerVerificationTemplatePath = resolveTemplatePath('SellerVerification.hbs')
let sellerVerificationTemplateCache: string | null = null

const getSellerVerificationTemplate = (): string => {
  if (sellerVerificationTemplateCache) return sellerVerificationTemplateCache
  sellerVerificationTemplateCache = fs.readFileSync(sellerVerificationTemplatePath, 'utf8')
  return sellerVerificationTemplateCache
}

const sellerPasswordResetTemplatePath = resolveTemplatePath('SellerPasswordReset.hbs')
let sellerPasswordResetTemplateCache: string | null = null

const getSellerPasswordResetTemplate = (): string => {
  if (sellerPasswordResetTemplateCache) return sellerPasswordResetTemplateCache
  sellerPasswordResetTemplateCache = fs.readFileSync(sellerPasswordResetTemplatePath, 'utf8')
  return sellerPasswordResetTemplateCache
}

const sellerProfileStatusTemplatePath = resolveTemplatePath('SellerProfileStatus.hbs')
let sellerProfileStatusTemplateCache: string | null = null

const getSellerProfileStatusTemplate = (): string => {
  if (sellerProfileStatusTemplateCache) return sellerProfileStatusTemplateCache
  sellerProfileStatusTemplateCache = fs.readFileSync(sellerProfileStatusTemplatePath, 'utf8')
  return sellerProfileStatusTemplateCache
}

const productStatusTemplatePath = resolveTemplatePath('ProductStatus.hbs')
let productStatusTemplateCache: string | null = null

const getProductStatusTemplate = (): string => {
  if (productStatusTemplateCache) return productStatusTemplateCache
  productStatusTemplateCache = fs.readFileSync(productStatusTemplatePath, 'utf8')
  return productStatusTemplateCache
}

const renderTemplate = (template: string, values: Record<string, string>): string => {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => values[key] ?? '')
}

const FOOTER_SENDER_EMAIL_TOKEN = '__SENDER_EMAIL__'
const EMAIL_HEADER_LOGO_CID = 'platform-header-logo'
const EMAIL_HEADER_LOGO_PATH = resolveTemplatePath('logo.svg')
export const EMAIL_HEADER_LOGO_HTML = `<img src="cid:${EMAIL_HEADER_LOGO_CID}" width="44" height="44" alt="Platform logo" style="display:block;width:44px;height:44px;border:0;outline:none;text-decoration:none;border-radius:10px;" />`

export const createEmailFooterHtml = (input: {
  company_name: string
  company_email: string
  company_address: string
  organization_number: string
  introText?: string
}): string => {
  return renderTemplate(getEmailFooterTemplate(), {
    company_name: String(input.company_name || '').trim(),
    // Resolve to actual sender at send time so footer email always matches From.
    company_email: FOOTER_SENDER_EMAIL_TOKEN,
    company_address: String(input.company_address || '').trim(),
    organization_number: String(input.organization_number || '').trim(),
    footer_intro_text: String(input.introText || 'If you have any questions, please contact:').trim(),
  })
}

type EmailCompanyInfo = {
  company_logo_url: string
  company_name: string
  company_email: string
  company_address: string
  organization_number: string
}

export const createSellerVerificationEmailHtml = (input: { company: EmailCompanyInfo; verification_url: string }): string => {
  const footer = createEmailFooterHtml({
    company_name: input.company.company_name,
    company_email: input.company.company_email,
    company_address: input.company.company_address,
    organization_number: input.company.organization_number,
  })
  return renderTemplate(getSellerVerificationTemplate(), {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    verification_url: normalizeEmailUrl(input.verification_url),
    email_footer: footer,
    email_header_logo: EMAIL_HEADER_LOGO_HTML,
  })
}

export const createSellerPasswordResetEmailHtml = (input: { company: EmailCompanyInfo; reset_url: string }): string => {
  const footer = createEmailFooterHtml({
    company_name: input.company.company_name,
    company_email: input.company.company_email,
    company_address: input.company.company_address,
    organization_number: input.company.organization_number,
  })
  return renderTemplate(getSellerPasswordResetTemplate(), {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    reset_url: normalizeEmailUrl(input.reset_url),
    email_footer: footer,
    email_header_logo: EMAIL_HEADER_LOGO_HTML,
  })
}


type InvoiceItemInput = {
  product_name: string
  quantity: number | null
  unit_price: number
  tax_amount: number
  total_price: number
  seller_key?: string
  is_private_seller?: boolean
  product_type?: 'item' | 'shipment'
}

type InvoiceCompanyInfo = {
  company_logo_url: string
  company_name: string
  company_email: string
  company_address: string
  organization_number: string
}

type DigitalProductDownloadItem = {
  product_name: string
  download_url: string
}

type CreateDigitalProductEmailHtmlInput = {
  company: InvoiceCompanyInfo
  customer_name: string
  order_id: string
  order_date: string
  items: DigitalProductDownloadItem[]
}

export const createDigitalProductEmailHtml = (input: CreateDigitalProductEmailHtmlInput): string => {
  const productRowsHtml = input.items
    .map((item, index) => {
      const rowBg = index % 2 === 0 ? '#ffffff' : '#f9fafb'

      return `<tr style="background-color:${rowBg};">
        <td align="left" style="padding:14px 16px; font-size:13px; font-weight:500;">${item.product_name}</td>
        <td align="left" style="padding:12px 16px;">
          <a href="${normalizeEmailUrl(item.download_url)}" style="display:inline-block; padding:8px 20px; background-color:#111827; color:#ffffff; text-decoration:none; border-radius:8px; font-size:13px; font-weight:600;">Download</a>
        </td>
      </tr>`
    })
    .join('')

  const template = getDigitalProductTemplate()

  return renderTemplate(template, {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    email_header_logo: EMAIL_HEADER_LOGO_HTML,
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    customer_name: String(input.customer_name || 'Customer'),
    order_id: String(input.order_id || ''),
    order_date: String(input.order_date || ''),
    product_rows: productRowsHtml || '<tr><td colspan="2" style="padding:14px 16px; text-align:center; font-size:13px; color:#6b7280;">No downloads available.</td></tr>',
    email_footer: createEmailFooterHtml({
      company_name: String(input.company.company_name || ''),
      company_email: String(input.company.company_email || ''),
      company_address: String(input.company.company_address || ''),
      organization_number: String(input.company.organization_number || ''),
      introText: 'If you have any questions about this order, please contact:',
    }),
  })
}

type CreateInvoiceEmailHtmlInput = {
  company: InvoiceCompanyInfo
  customer_name: string
  order_id: string
  order_date: string
  customer_email: string
  shipping_address: string
  seller_email: string
  grand_total: number
  tax_amount?: number
  commission_amount: number
  net_amount: number
  items: InvoiceItemInput[]
}

export const createInvoiceEmailHtml = (input: CreateInvoiceEmailHtmlInput): string => {
  const shipmentBuckets = {
    unit_price: 0,
    tax_amount: 0,
    total_price: 0,
  }

  const normalizedItems: InvoiceItemInput[] = []
  for (const item of input.items) {
    const isShipment =
      item.product_type === 'shipment' ||
      String(item.product_name || '').trim().toLowerCase() === 'shipment'

    if (isShipment) {
      shipmentBuckets.unit_price += Number(item.unit_price || 0)
      shipmentBuckets.tax_amount += Number(item.tax_amount || 0)
      shipmentBuckets.total_price += Number(item.total_price || 0)
      continue
    }

    normalizedItems.push({
      ...item,
      product_name: String(item.product_name || ''),
      quantity: Number(item.quantity || 0),
      unit_price: Number(item.unit_price || 0),
      tax_amount: Number(item.tax_amount || 0),
      total_price: Number(item.total_price || 0),
      is_private_seller: Boolean(item.is_private_seller),
    })
  }

  if (shipmentBuckets.unit_price > 0 || shipmentBuckets.tax_amount > 0 || shipmentBuckets.total_price > 0) {
    normalizedItems.push({
      product_name: 'Shipment',
      quantity: null,
      unit_price: shipmentBuckets.unit_price,
      tax_amount: shipmentBuckets.tax_amount,
      total_price: shipmentBuckets.total_price,
      product_type: 'shipment',
    })
  }

  const palette = ['#eff6ff', '#f0fdf4', '#fff7ed', '#f5f3ff', '#ecfeff', '#fefce8']
  const sellerColorMap = new Map<string, string>()
  let colorIndex = 0

  const itemsHtml = normalizedItems
    .map((item) => {
      const isShipment = String(item.product_name).toLowerCase() === 'shipment'
      const sellerKey = String(item.seller_key || '')
      let rowBg = '#ffffff'

      if (isShipment) {
        rowBg = '#f3f4f6'
      } else {
        if (!sellerColorMap.has(sellerKey)) {
          sellerColorMap.set(sellerKey, palette[colorIndex % palette.length])
          colorIndex += 1
        }
        rowBg = sellerColorMap.get(sellerKey) || '#ffffff'
      }

      const qty = Number(item.quantity || 0)
      const unitPrice = Number(item.unit_price || 0).toFixed(2)
      const hasPrivateSellerVatMarker = !isShipment && Boolean(item.is_private_seller) && Number(item.tax_amount || 0) === 0
      const lineTax = `${Number(item.tax_amount || 0).toFixed(2)}${hasPrivateSellerVatMarker ? '*' : ''}`
      const lineTotal = (Number(item.total_price || 0) + Number(item.tax_amount || 0)).toFixed(2)

      return `<tr style="background-color:${rowBg};">
          <td align="left" style="padding:14px 16px; font-size:13px; font-weight:500;">${item.product_name}</td>
          <td align="left" style="padding:14px 16px; font-size:13px; font-weight:500;">${isShipment ? '' : qty}</td>
          <td align="left" style="padding:14px 16px; font-size:13px; font-weight:500;">${isShipment ? '' : unitPrice}</td>
          <td align="left" style="padding:14px 16px; font-size:13px; font-weight:500;">${lineTax}</td>
          <td align="left" style="padding:14px 16px; font-size:13px; font-weight:500;">${lineTotal}</td>
        </tr>`
    })
    .join('')

  const hasPrivateSellerVatZeroItems = normalizedItems.some((item) => {
    const isShipment = String(item.product_name).toLowerCase() === 'shipment'
    return !isShipment && Boolean(item.is_private_seller) && Number(item.tax_amount || 0) === 0
  })

  const computedTax = normalizedItems.reduce((sum, item) => sum + Number(item.tax_amount || 0), 0)
  const summaryTax = Number.isFinite(Number(input.tax_amount)) ? Number(input.tax_amount) : computedTax

  const totalTax = normalizedItems.reduce((sum, item) => sum + Number(item.tax_amount || 0), 0)
  const totalLineTotal = normalizedItems.reduce((sum, item) => sum + Number(item.total_price || 0) + Number(item.tax_amount || 0), 0)
  const totalsFooterRow = `<tr style="background-color:#f1f5f9;">
      <td colspan="3" align="right" style="padding:12px 16px; font-size:13px; font-weight:700; color:#111827; border-top:2px solid #d1d5db;">Totals</td>
      <td align="left" style="padding:12px 16px; font-size:13px; font-weight:700; color:#111827; border-top:2px solid #d1d5db;">SEK ${totalTax.toFixed(2)}</td>
      <td align="left" style="padding:12px 16px; font-size:13px; font-weight:700; color:#111827; border-top:2px solid #d1d5db;">SEK ${totalLineTotal.toFixed(2)}</td>
    </tr>`

  const template = getInvoiceTemplate()

  return renderTemplate(template, {
        email_header_logo: EMAIL_HEADER_LOGO_HTML,
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    customer_name: String(input.customer_name || 'Customer'),
    order_id: String(input.order_id || ''),
    order_date: String(input.order_date || ''),
    customer_email: String(input.customer_email || ''),
    shipping_address: String(input.shipping_address || 'N/A'),
    seller_email: String(input.seller_email || ''),
    grand_total: Number(input.grand_total || 0).toFixed(2),
    tax_amount: Number(summaryTax || 0).toFixed(2),
    commission_amount: Number(input.commission_amount || 0).toFixed(2),
    net_amount: Number(input.net_amount || 0).toFixed(2),
    items_rows: itemsHtml || '<tr><td colspan="5">No items available.</td></tr>',
    totals_footer_row: totalsFooterRow,
    private_seller_vat_note: hasPrivateSellerVatZeroItems
      ? '* Item(s) marked with * have 0% VAT because the seller is a private seller.'
      : '',
    email_footer: createEmailFooterHtml({
      company_name: String(input.company.company_name || ''),
      company_email: String(input.company.company_email || ''),
      company_address: String(input.company.company_address || ''),
      organization_number: String(input.company.organization_number || ''),
      introText: 'If you have any questions about this order, please contact:',
    }),
  })
}

type CreateShipmentNotificationEmailHtmlInput = {
  company: InvoiceCompanyInfo
  customer_name: string
  order_id: string
  order_date: string
  tracking_number: string
  tracking_url: string
  shipping_address?: string
}

type SellerPayoutOrderRow = {
  order_id: string
  order_date: string
  revenue: number
  commission: number
  payout: number
}

type CreateSellerPayoutReceiptEmailHtmlInput = {
  company: InvoiceCompanyInfo
  seller_name: string
  payout_reference: string
  payout_date: string
  total_orders: number
  total_revenue: number
  total_commission: number
  total_payout: number
  orders: SellerPayoutOrderRow[]
}

type CreateSellerOrderReceivedEmailHtmlInput = {
  company: InvoiceCompanyInfo
  seller_name: string
  customer_name: string
  order_id: string
  group_order_id: string
  order_date: string
  total_amount: number
  total_items: number
}

export const createShipmentNotificationEmailHtml = (input: CreateShipmentNotificationEmailHtmlInput): string => {
  const template = getShipmentTemplate()
  return renderTemplate(template, {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    email_header_logo: EMAIL_HEADER_LOGO_HTML,
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    customer_name: String(input.customer_name || 'Customer'),
    order_id: String(input.order_id || ''),
    order_date: String(input.order_date || ''),
    tracking_number: String(input.tracking_number || ''),
    tracking_url: normalizeEmailUrl(input.tracking_url),
    shipping_address: String(input.shipping_address || 'N/A'),
    email_footer: createEmailFooterHtml({
      company_name: String(input.company.company_name || ''),
      company_email: String(input.company.company_email || ''),
      company_address: String(input.company.company_address || ''),
      organization_number: String(input.company.organization_number || ''),
      introText: 'Questions about your order? Contact us:',
    }),
  })
}

export const createSellerPayoutReceiptEmailHtml = (input: CreateSellerPayoutReceiptEmailHtmlInput): string => {
  const rowsHtml = input.orders
    .map((order, index) => {
      const rowBg = index % 2 === 0 ? '#ffffff' : '#f9fafb'
      return `<tr style="background-color:${rowBg};">
        <td style="padding:12px 16px; font-size:13px; font-weight:600;">${order.order_id}</td>
        <td style="padding:12px 16px; font-size:13px;">${order.order_date}</td>
        <td style="padding:12px 16px; font-size:13px;">${order.revenue.toFixed(2)}</td>
        <td style="padding:12px 16px; font-size:13px;">${order.commission.toFixed(2)}</td>
        <td style="padding:12px 16px; font-size:13px; font-weight:700; color:#047857;">${order.payout.toFixed(2)}</td>
      </tr>`
    })
    .join('')

  const template = getSellerPayoutReceiptTemplate()
  return renderTemplate(template, {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    email_header_logo: EMAIL_HEADER_LOGO_HTML,
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    seller_name: String(input.seller_name || 'Seller').trim(),
    payout_reference: String(input.payout_reference || ''),
    payout_date: String(input.payout_date || ''),
    total_orders: String(Number(input.total_orders || 0)),
    total_revenue: Number(input.total_revenue || 0).toFixed(2),
    total_commission: Number(input.total_commission || 0).toFixed(2),
    total_payout: Number(input.total_payout || 0).toFixed(2),
    orders_rows: rowsHtml || '<tr><td colspan="5" style="padding:12px 16px; font-size:13px; color:#6b7280;">No orders included in this payout.</td></tr>',
    email_footer: createEmailFooterHtml({
      company_name: String(input.company.company_name || ''),
      company_email: String(input.company.company_email || ''),
      company_address: String(input.company.company_address || ''),
      organization_number: String(input.company.organization_number || ''),
      introText: 'Questions about this payout? Contact:',
    }),
  })
}

export const createSellerOrderReceivedEmailHtml = (input: CreateSellerOrderReceivedEmailHtmlInput): string => {
  const template = getSellerOrderReceivedTemplate()

  return renderTemplate(template, {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    email_header_logo: EMAIL_HEADER_LOGO_HTML,
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    seller_name: String(input.seller_name || 'Seller').trim(),
    customer_name: String(input.customer_name || 'Customer').trim(),
    order_id: String(input.order_id || '').trim(),
    group_order_id: String(input.group_order_id || '').trim(),
    order_date: String(input.order_date || '').trim(),
    total_amount: Number(input.total_amount || 0).toFixed(2),
    total_items: String(Number(input.total_items || 0)),
    email_footer: createEmailFooterHtml({
      company_name: String(input.company.company_name || ''),
      company_email: String(input.company.company_email || ''),
      company_address: String(input.company.company_address || ''),
      organization_number: String(input.company.organization_number || ''),
      introText: 'If you have any questions about this order, please contact:',
    }),
  })
}

type SendEmailOptions = {
  useTestSender?: boolean
  testSenderEmail?: string
  attachments?: Array<{
    filename: string
    path: string
    contentType?: string
  }>
  purpose?: 'sellers' | 'customers' | 'newsletters' | 'contact_form'
}

export const sendEmail = async (
  receiverEmail: string,
  subject: string,
  body: string,
  options?: SendEmailOptions,
): Promise<{ success: true; messageId: string }> => {
  if (!receiverEmail || !subject || !body) {
    throw new Error('receiverEmail, subject, and body are required')
  }

  const useTestSender = Boolean(options?.useTestSender)
  const fromName = String(SMTP.fromName || 'Platform').trim()
  let purposeSendError: unknown = null

  const inlineHeaderLogoAttachment = {
    filename: 'logo.svg',
    path: EMAIL_HEADER_LOGO_PATH,
    contentType: 'image/svg+xml',
    cid: EMAIL_HEADER_LOGO_CID,
  }
  const mergedAttachments = [
    ...(options?.attachments || []),
    inlineHeaderLogoAttachment,
  ]

  // When a purpose is provided, try to load from the email_accounts table
  if (options?.purpose && !useTestSender) {
    try {
      if (emailAccountResolver) {
        const account = await emailAccountResolver(options.purpose)

        if (account) {
          const senderEmail = String(account.email_address)

          // Prefer runtime DB settings over env config
          const runtimeSmtp = smtpSettingsResolver ? await smtpSettingsResolver() : null
          const smtpHost = runtimeSmtp?.host ?? SMTP.host
          const smtpPort = runtimeSmtp?.port ?? SMTP.port
          const smtpSecure = runtimeSmtp?.secure ?? SMTP.secure

          const looksLikeHtml = /<[^>]+>/.test(body)
          const htmlBodyRaw = looksLikeHtml ? body : `<p>${body.replace(/\n/g, '<br/>')}</p>`
          const htmlBody = htmlBodyRaw.split(FOOTER_SENDER_EMAIL_TOKEN).join(senderEmail)
          const textBody = looksLikeHtml ? stripHtml(htmlBody) : body

          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            ...(smtpPort === 587 && !smtpSecure ? { requireTLS: true } : {}),
            auth: {
              user: senderEmail,
              pass: account.plain_password,
            },
          })

          const info = await transporter.sendMail({
            from: `"${fromName}" <${senderEmail}>`,
            to: receiverEmail,
            subject,
            text: textBody,
            html: htmlBody,
            attachments: mergedAttachments,
          })

          return {
            success: true,
            messageId: String(info.messageId || ''),
          }
        }
      }
    } catch (purposeError) {
      purposeSendError = purposeError
      console.warn(`[sendEmail] Failed to use purpose account (${options.purpose}), falling back to default:`, purposeError)
    }
  }

  // Default / fallback behavior (DB-first via resolver)
  let smtpUser = ''
  let smtpPass = ''
  if (!useTestSender && smtpDefaultCredentialsResolver) {
    try {
      const creds = await smtpDefaultCredentialsResolver()
      smtpUser = String(creds?.user || '').trim()
      smtpPass = String(creds?.pass || '').trim()
    } catch {
      // ignore and continue with static fallback
    }
  }

  if (!smtpUser || !smtpPass) {
    smtpUser = String(SMTP.user || EMAIL.address || '').trim()
    smtpPass = String(SMTP.pass || '').trim()
  }

  const defaultTestSender = String(EMAIL.address || '').trim()

  // If env SMTP not configured, try any active DB account as last resort
  if ((!smtpUser || !smtpPass) && emailAccountResolver && !useTestSender) {
    try {
      const fallbackAccount = await emailAccountResolver('sellers')
        ?? await emailAccountResolver('customers')
        ?? await emailAccountResolver('contact_form')
      if (fallbackAccount) {
        smtpUser = fallbackAccount.email_address
        smtpPass = fallbackAccount.plain_password
      }
    } catch {
      // ignore
    }
  }

  const senderEmail = useTestSender
    ? String(options?.testSenderEmail || defaultTestSender).trim()
    : smtpUser
  const smtpConfigured = Boolean(smtpUser && smtpPass)

  if (!smtpConfigured && !useTestSender) {
    if (purposeSendError instanceof Error) {
      throw new Error(`Failed to send email with purpose account '${String(options?.purpose || '')}': ${purposeSendError.message}`)
    }
    throw new Error('SMTP_USER and SMTP_PASS must be configured')
  }

  if (!senderEmail) {
    throw new Error('Sender email is required')
  }

  if (!smtpConfigured && useTestSender) {
    console.warn('[Email Test Mode] SMTP credentials are missing. Skipping actual send.', {
      to: receiverEmail,
      subject,
      from: senderEmail,
    })

    return {
      success: true,
      messageId: `test-mode-${Date.now()}`,
    }
  }

  const looksLikeHtml = /<[^>]+>/.test(body)
  const htmlBodyRaw = looksLikeHtml ? body : `<p>${body.replace(/\n/g, '<br/>')}</p>`
  const htmlBody = htmlBodyRaw.split(FOOTER_SENDER_EMAIL_TOKEN).join(senderEmail)
  const textBody = looksLikeHtml ? stripHtml(htmlBody) : body

  // Read live from SMTP config (prefer runtime DB settings over env)
  const runtimeSmtpFb = smtpSettingsResolver ? await smtpSettingsResolver().catch(() => null) : null
  const liveHost = runtimeSmtpFb?.host ?? SMTP.host
  const livePort = runtimeSmtpFb?.port ?? SMTP.port
  const liveSecure = runtimeSmtpFb?.secure ?? SMTP.secure

  const transporter = nodemailer.createTransport({
    host: liveHost,
    port: livePort,
    secure: liveSecure,
    // For STARTTLS (port 587, secure=false): require TLS upgrade after connect
    ...(livePort === 587 && !liveSecure ? { requireTLS: true } : {}),
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  })

  const info = await transporter.sendMail({
    from: `"${fromName}" <${senderEmail}>`,
    to: receiverEmail,
    subject,
    text: textBody,
    html: htmlBody,
    attachments: mergedAttachments,
  })

  return {
    success: true,
    messageId: String(info.messageId || ''),
  }
}

type SellerProfileStatusEmailInput = {
  company: EmailCompanyInfo
  seller_name: string
  seller_email: string
  status: 'verified' | 'pending' | 'rejected' | 'blocked'
  reason?: string | null
  updated_at: string
  cta_url: string
}

export const createSellerProfileStatusEmailHtml = (input: SellerProfileStatusEmailInput): string => {
  const statusMap: Record<string, { label: string; bg: string; color: string; intro: string; ctaLabel: string; ctaBg: string }> = {
    verified: {
      label: 'Approved',
      bg: '#dcfce7', color: '#15803d',
      intro: `Great news — your seller profile has been reviewed and approved. You can now list products and start selling on the platform.`,
      ctaLabel: 'Go to Dashboard',
      ctaBg: '#16a34a',
    },
    pending: {
      label: 'Pending Review',
      bg: '#fef9c3', color: '#854d0e',
      intro: `Thank you for submitting your seller profile. Our admin team will review it shortly. Once approved, you will be able to add products and start selling on the platform.`,
      ctaLabel: 'View Profile',
      ctaBg: '#d97706',
    },
    rejected: {
      label: 'Requires Update',
      bg: '#fee2e2', color: '#b91c1c',
      intro: `Your seller profile has been reviewed and requires updates before it can be approved. Please read the admin's message below, update your profile, and resubmit.`,
      ctaLabel: 'Update Profile',
      ctaBg: '#dc2626',
    },
    blocked: {
      label: 'Account Suspended',
      bg: '#fff7ed', color: '#c2410c',
      intro: `Your seller account has been suspended by an administrator. While suspended, all your products are hidden from customers and you cannot list new products. Please contact support if you believe this is a mistake.`,
      ctaLabel: 'Contact Support',
      ctaBg: '#ea580c',
    },
  }
  const s = statusMap[input.status] || statusMap['pending']
  const reason = String(input.reason || '').trim()
  const reasonBlock = reason
    ? `<tr><td style="padding:0 32px 20px 32px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-left:4px solid ${s.color}; background:${s.bg}; border-radius:4px; padding:14px 18px;">
          <tr><td><p style="margin:0 0 4px 0; font-size:12px; font-weight:700; color:${s.color}; text-transform:uppercase; letter-spacing:0.5px;">Message from admin</p>
          <p style="margin:0; font-size:14px; color:#374151; white-space:pre-wrap;">${reason}</p></td></tr>
        </table>
      </td></tr>`
    : ''

  const footer = createEmailFooterHtml({
    company_name: input.company.company_name,
    company_email: input.company.company_email,
    company_address: input.company.company_address,
    organization_number: input.company.organization_number,
  })

  return renderTemplate(getSellerProfileStatusTemplate(), {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    email_header_logo: EMAIL_HEADER_LOGO_HTML,
    company_name: String(input.company.company_name || '').trim(),
    seller_name: String(input.seller_name || 'Seller').trim(),
    seller_email: String(input.seller_email || '').trim(),
    intro_text: s.intro,
    status_label: s.label,
    status_bg: s.bg,
    status_color: s.color,
    reason_block: reasonBlock,
    updated_at: input.updated_at,
    cta_url: normalizeEmailUrl(input.cta_url),
    cta_label: s.ctaLabel,
    cta_bg: s.ctaBg,
    email_footer: footer,
  })
}

type ProductStatusEmailInput = {
  company: EmailCompanyInfo
  seller_name: string
  product_name: string
  product_id: string | number
  product_category: string
  status: 'approved' | 'rejected'
  rejection_message?: string | null
  updated_at: string
  cta_url: string
}

export const createProductStatusEmailHtml = (input: ProductStatusEmailInput): string => {
  const isApproved = input.status === 'approved'
  const statusLabel = isApproved ? 'Approved' : 'Requires Update'
  const statusBg = isApproved ? '#dcfce7' : '#fee2e2'
  const statusColor = isApproved ? '#15803d' : '#b91c1c'
  const intro = isApproved
    ? `Good news — your product has been reviewed and approved. It is now visible to customers on the platform.`
    : `Your product requires changes before it can be approved. Please review the feedback below and update your listing.`
  const ctaLabel = isApproved ? 'View Your Products' : 'Edit Product'
  const ctaBg = isApproved ? '#16a34a' : '#dc2626'

  const reason = String(input.rejection_message || '').trim()
  const reasonBlock = reason
    ? `<tr><td style="padding:0 32px 20px 32px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-left:4px solid #dc2626; background:#fee2e2; border-radius:4px; padding:14px 18px;">
          <tr><td><p style="margin:0 0 4px 0; font-size:12px; font-weight:700; color:#b91c1c; text-transform:uppercase; letter-spacing:0.5px;">Reason for rejection</p>
          <p style="margin:0; font-size:14px; color:#374151; white-space:pre-wrap;">${reason}</p></td></tr>
        </table>
      </td></tr>`
    : ''

  const footer = createEmailFooterHtml({
    company_name: input.company.company_name,
    company_email: input.company.company_email,
    company_address: input.company.company_address,
    organization_number: input.company.organization_number,
  })

  return renderTemplate(getProductStatusTemplate(), {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    email_header_logo: EMAIL_HEADER_LOGO_HTML,
    company_name: String(input.company.company_name || '').trim(),
    seller_name: String(input.seller_name || 'Seller').trim(),
    intro_text: intro,
    status_label: statusLabel,
    status_bg: statusBg,
    status_color: statusColor,
    product_name: String(input.product_name || '').trim(),
    product_id: String(input.product_id || '').trim(),
    product_category: String(input.product_category || '—').trim(),
    reason_block: reasonBlock,
    updated_at: input.updated_at,
    cta_url: normalizeEmailUrl(input.cta_url),
    cta_label: ctaLabel,
    cta_bg: ctaBg,
    email_footer: footer,
  })
}

type DeliveryReviewRequestEmailInput = {
  company: EmailCompanyInfo
  seller_name: string
  customer_name: string
  product_name: string
  review_url: string
  language?: 'en' | 'sv'
}

export const createDeliveryReviewRequestEmailHtml = (input: DeliveryReviewRequestEmailInput): string => {
  const language = input.language === 'sv' ? 'sv' : 'en'

  const copy = language === 'sv'
    ? {
        title: 'Be kunden om omdöme',
        intro: 'Den här beställningen är levererad. Dela länken nedan med kunden så att de kan lämna ett betyg och en kommentar.',
        button: 'Öppna omdömessida',
        helper: 'Om knappen inte fungerar kan du kopiera och dela länken manuellt:',
        orderLineLabel: 'Produkt',
        customerLineLabel: 'Kund',
      }
    : {
        title: 'Request a customer review',
        intro: 'This order has been delivered. Share the link below with your customer so they can leave a rating and a comment.',
        button: 'Open review page',
        helper: 'If the button does not work, copy and share this link manually:',
        orderLineLabel: 'Product',
        customerLineLabel: 'Customer',
      }

  const footer = createEmailFooterHtml({
    company_name: input.company.company_name,
    company_email: input.company.company_email,
    company_address: input.company.company_address,
    organization_number: input.company.organization_number,
  })

  const normalizedReviewUrl = normalizeEmailUrl(input.review_url)
  const sellerName = String(input.seller_name || 'Seller').trim()
  const customerName = String(input.customer_name || 'Customer').trim()
  const productName = String(input.product_name || '').trim()
  const companyName = String(input.company.company_name || '').trim()
  const companyAddress = String(input.company.company_address || '').trim()
  const companyOrgNumber = String(input.company.organization_number || '').trim()
  const companyMeta = [
    companyAddress,
    companyOrgNumber ? `Org ${companyOrgNumber}` : '',
  ].filter(Boolean).join(' • ')

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="padding:24px 28px;background:#111827;color:#ffffff;">
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin-bottom:12px;">
                  <tr>
                    <td style="width:36px;height:36px;padding-right:10px;vertical-align:middle;">
                      ${EMAIL_HEADER_LOGO_HTML}
                    </td>
                    <td style="vertical-align:middle;">
                      <p style="margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#cbd5e1;">${companyName}</p>
                      <p style="margin:4px 0 0 0;font-size:11px;line-height:1.4;color:#93c5fd;">${companyMeta}</p>
                    </td>
                  </tr>
                </table>
                <h1 style="margin:8px 0 0 0;font-size:24px;line-height:1.25;">${copy.title}</h1>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 28px 8px 28px;">
                <p style="margin:0 0 14px 0;font-size:15px;line-height:1.65;color:#374151;">${copy.intro}</p>
                <p style="margin:0;font-size:14px;line-height:1.6;color:#111827;"><strong>${copy.customerLineLabel}:</strong> ${customerName}</p>
                <p style="margin:6px 0 0 0;font-size:14px;line-height:1.6;color:#111827;"><strong>${copy.orderLineLabel}:</strong> ${productName || '—'}</p>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 28px 10px 28px;">
                <a href="${normalizedReviewUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:700;">${copy.button}</a>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 28px 24px 28px;">
                <p style="margin:0 0 8px 0;font-size:12px;color:#6b7280;">${copy.helper}</p>
                <p style="margin:0;font-size:12px;word-break:break-all;"><a href="${normalizedReviewUrl}" style="color:#2563eb;">${normalizedReviewUrl}</a></p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 28px 28px;">${footer}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `
}

export default sendEmail
