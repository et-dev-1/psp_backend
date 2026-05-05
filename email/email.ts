import fs from 'fs'
import path from 'path'
const nodemailer = require('nodemailer')
import { SMTP, EMAIL, COMPANY_ORGANIZATION_NUMBER } from '../config'

const host = SMTP.host
const port = SMTP.port
const secure = SMTP.secure
const username = SMTP.user
const password = SMTP.pass
const fromName = SMTP.fromName
const defaultTestSender = EMAIL.address
const organizationNumber = COMPANY_ORGANIZATION_NUMBER || 'N/A'

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: {
    user: username,
    pass: password,
  },
})

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

const invoiceTemplatePath = path.join(__dirname, 'InvoiceCustomer.hbs')
let invoiceTemplateCache: string | null = null

const getInvoiceTemplate = (): string => {
  if (invoiceTemplateCache) return invoiceTemplateCache
  invoiceTemplateCache = fs.readFileSync(invoiceTemplatePath, 'utf8')
  return invoiceTemplateCache
}

const digitalProductTemplatePath = path.join(__dirname, 'DigitalProduct.hbs')
let digitalProductTemplateCache: string | null = null

const getDigitalProductTemplate = (): string => {
  if (digitalProductTemplateCache) return digitalProductTemplateCache
  digitalProductTemplateCache = fs.readFileSync(digitalProductTemplatePath, 'utf8')
  return digitalProductTemplateCache
}

const shipmentTemplatePath = path.join(__dirname, 'Shipment.hbs')
let shipmentTemplateCache: string | null = null

const getShipmentTemplate = (): string => {
  if (shipmentTemplateCache) return shipmentTemplateCache
  shipmentTemplateCache = fs.readFileSync(shipmentTemplatePath, 'utf8')
  return shipmentTemplateCache
}

const sellerPayoutReceiptTemplatePath = path.join(__dirname, 'SellerPayoutReceipt.hbs')
let sellerPayoutReceiptTemplateCache: string | null = null

const getSellerPayoutReceiptTemplate = (): string => {
  if (sellerPayoutReceiptTemplateCache) return sellerPayoutReceiptTemplateCache
  sellerPayoutReceiptTemplateCache = fs.readFileSync(sellerPayoutReceiptTemplatePath, 'utf8')
  return sellerPayoutReceiptTemplateCache
}

const renderTemplate = (template: string, values: Record<string, string>): string => {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => values[key] ?? '')
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
        <td align="left" style="padding:14px 16px;">
          <a href="${item.download_url}" style="display:inline-block; padding:8px 16px; background-color:#111827; color:#ffffff; font-size:12px; font-weight:700; text-decoration:none; border-radius:8px;">Download</a>
        </td>
      </tr>`
    })
    .join('')

  const template = getDigitalProductTemplate()

  return renderTemplate(template, {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    customer_name: String(input.customer_name || 'Customer'),
    order_id: String(input.order_id || ''),
    order_date: String(input.order_date || ''),
    product_rows: productRowsHtml || '<tr><td colspan="2" style="padding:14px 16px; text-align:center; font-size:13px; color:#6b7280;">No downloads available.</td></tr>',
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

export const createShipmentNotificationEmailHtml = (input: CreateShipmentNotificationEmailHtmlInput): string => {
  const template = getShipmentTemplate()
  return renderTemplate(template, {
    company_logo_url: String(input.company.company_logo_url || '').trim(),
    company_name: String(input.company.company_name || '').trim(),
    company_email: String(input.company.company_email || '').trim(),
    company_address: String(input.company.company_address || '').trim(),
    organization_number: String(input.company.organization_number || '').trim(),
    customer_name: String(input.customer_name || 'Customer'),
    order_id: String(input.order_id || ''),
    order_date: String(input.order_date || ''),
    tracking_number: String(input.tracking_number || ''),
    tracking_url: String(input.tracking_url || '').trim(),
    shipping_address: String(input.shipping_address || 'N/A'),
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
  })
}

export const sendEmail = async (
  receiverEmail: string,
  subject: string,
  body: string,
  options?: {
    useTestSender?: boolean
    testSenderEmail?: string
    attachments?: Array<{
      filename: string
      path: string
      contentType?: string
    }>
  },
): Promise<{ success: true; messageId: string }> => {
  if (!receiverEmail || !subject || !body) {
    throw new Error('receiverEmail, subject, and body are required')
  }

  const useTestSender = Boolean(options?.useTestSender)
  const senderEmail = useTestSender
    ? String(options?.testSenderEmail || defaultTestSender).trim()
    : username
  const smtpConfigured = Boolean(username && password)

  if (!smtpConfigured && !useTestSender) {
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
  const htmlBody = looksLikeHtml ? body : `<p>${body.replace(/\n/g, '<br/>')}</p>`
  const textBody = looksLikeHtml ? stripHtml(body) : body

  const emailData = {
    ...{
      to: receiverEmail,
      subject,
      from: senderEmail,
      organizationNumber,
    },
    ...options,
  }

  const info = await transporter.sendMail({
    from: `"${fromName}" <${senderEmail}>`,
    to: receiverEmail,
    subject,
    text: textBody,
    html: htmlBody,
    attachments: options?.attachments,
  })

  return {
    success: true,
    messageId: String(info.messageId || ''),
  }
}

export default sendEmail