// ── Ports — repository interfaces cho domain invoicing ─────
import type { Prisma } from '@/generated/prisma/client'
import type { InvoiceItemType } from '@/generated/prisma/client'
import type { PaymentMethod } from '@/types'

export interface CreateInvoiceLineInput {
  type: InvoiceItemType
  description: string
  quantity: number
  unitPrice: number
  subtotal: number
  discountAmount: number
  total: number
  metadata?: Prisma.InputJsonValue
}

export interface CreatePaidInvoiceInput {
  invoiceNo: string
  /** Phiên chơi liên quan — bắt buộc cho invoice checkout (đọc tên/SĐT khách vãng lai, đếm lần thu trước) */
  sessionId?: string | null
  /** Null với khách vãng lai (không tạo Customer) */
  customerId: string | null
  shiftId: string
  staffId: string
  paidAt: Date
  notes?: string
  subtotal: number
  discountTotal: number
  grandTotal: number
  lines: CreateInvoiceLineInput[]
}

export interface CreatePaymentInput {
  invoiceId: string
  /** sessionId nullable cho thanh toán phi vận hành (phí hội viên) */
  sessionId?: string | null
  shiftId: string
  staffId: string
  totalHours: number
  subtotal: number
  discountTotal: number
  grandTotal: number
  paymentMethod: PaymentMethod
  paidAt: Date
  notes?: string
}

export interface EditStockMovementRef {
  id: string
  productId: string | null
  quantity: number
}

export interface EditInvoiceItemRef {
  id: string
  type: InvoiceItemType
  productId: string | null
  description: string
  quantity: number
  unitPrice: number
  subtotal: number
  discountAmount: number
  total: number
  metadata: Prisma.JsonValue | null
  stockMovements: EditStockMovementRef[]
}

export interface EditInvoiceTarget {
  id: string
  invoiceNo: string
  status: string
  shiftId: string | null
  customerId: string | null
  sessionId: string | null
  paidAt: Date | null
  notes: string | null
  subtotal: number
  discountTotal: number
  grandTotal: number
  staff: { fullName: string } | null
  items: EditInvoiceItemRef[]
  payments: Array<{ id: string; totalHours: number | null; paymentMethod: string | null; kind: string }>
}

export interface UpdateInvoiceFinancialsInput {
  subtotal: number
  discountTotal: number
  grandTotal: number
  notes: string
}

export interface CreateInvoiceItemInput {
  invoiceId: string
  productId?: string | null
  type: InvoiceItemType
  description: string
  quantity: number
  unitPrice: number
  subtotal: number
  discountAmount: number
  total: number
  metadata?: Prisma.InputJsonValue
}

export interface CreateMembershipPaymentInput {
  customerId: string
  membershipId: string
  planId: string
  invoiceId: string
  shiftId: string
  staffId: string
  amount: number
  paymentMethod: PaymentMethod
  paidAt: Date
  notes?: string
}

export interface VoidStockMovementRef {
  id: string
  productId: string | null
  quantity: number
}

export interface VoidInvoiceItemRef {
  id: string
  type: string
  productId: string | null
  stockMovements: VoidStockMovementRef[]
}

export interface VoidInvoiceTarget {
  id: string
  invoiceNo: string
  grandTotal: number
  status: string
  notes: string | null
  shiftId: string | null
  sessionId: string | null
  items: VoidInvoiceItemRef[]
  staff: { fullName: string } | null
}

export interface ReverseStockInput {
  invoiceItemId: string | null
  productId: string
  shiftId: string
  staffId: string
  quantity: number
  reason: string
}

/** Invoice chi tiết (deep include) — GET /api/invoices/[id] */
export type InvoiceDetail = Prisma.InvoiceGetPayload<{
  include: {
    customer: { select: { id: true; fullName: true; phone: true; type: true } }
    session: { select: { id: true; startTime: true; endTime: true; status: true; customerName: true, customerPhone: true, totalPausedSeconds: true } }
    shift: { select: { id: true; openedAt: true; closedAt: true } }
    staff: { select: { id: true; fullName: true } }
    items: {
      include: { product: { select: { id: true; name: true; sku: true; type: true } } }
      orderBy: { createdAt: 'asc' }
    }
    payments: {
      include: {
        staff: { select: { id: true; fullName: true } }
        membership: { include: { plan: { select: { name: true } } } }
        plan: { select: { id: true; name: true } }
        /** Fallback khi Invoice.sessionId null (hoá đơn cũ) — tên/SĐT khách vãng lai nằm trên phiên */
        session: { select: { id: true; customerName: true; customerPhone: true } }
      }
    }
  }
}>

/** Invoice trong lịch sử thanh toán của khách — deep include, dùng cho GET /api/customers/[id]/history */
export type CustomerInvoiceHistory = Prisma.InvoiceGetPayload<{
  include: {
    session: { select: { id: true; startTime: true; endTime: true; status: true; customerName: true; totalHours: true; totalAmount: true } }
    shift: { select: { id: true; openedAt: true; status: true } }
    staff: { select: { id: true; fullName: true } }
    items: {
      select: {
        id: true
        type: true
        description: true
        quantity: true
        unitPrice: true
        subtotal: true
        discountAmount: true
        total: true
        product: { select: { id: true; name: true; type: true } }
      }
      orderBy: { createdAt: 'asc' }
    }
    payments: {
      select: {
        id: true
        kind: true
        paymentMethod: true
        grandTotal: true
        paidAt: true
        plan: { select: { id: true; name: true } }
      }
    }
  }
}>

/** Invoice tối giản — cho DELETE guard (INVOICE_LINKED) */
export interface InvoiceDeleteTarget {
  id: string
  invoiceNo: string
  status: string
  grandTotal: number
  staffId: string
  customerId: string | null
  items: Array<{ id: string }>
}

export interface BillingRepository {
  /** Invoice + items + StockMovement SALE + staff — dùng cho void */
  findVoidTarget(invoiceId: string): Promise<VoidInvoiceTarget | null>
  /** Items (kèm StockMovement SALE) của các DRAFT invoice đã merge vào hoá đơn này */
  findMergedDraftItems(sessionId: string, invoiceNo: string): Promise<VoidInvoiceItemRef[]>
  /** Hoàn trả tồn kho: product.stockQuantity + StockMovement VOID */
  reverseStock(input: ReverseStockInput): Promise<void>
  /** Đánh dấu hoá đơn CANCELLED kèm notes */
  markInvoiceCancelled(invoiceId: string, notes: string): Promise<void>
  /** Tạo invoice PAID kèm line items (dùng cho phí hội viên, bán hàng...) */
  createPaidInvoice(input: CreatePaidInvoiceInput): Promise<{ id: string; invoiceNo: string }>
  /** Tạo payment cho invoice */
  createPayment(input: CreatePaymentInput): Promise<{ id: string }>
  /** Tạo MembershipPayment (phí hội viên) */
  createMembershipPayment(input: CreateMembershipPaymentInput): Promise<{ id: string }>
  /** Tạo invoice item */
  createInvoiceItem(input: CreateInvoiceItemInput): Promise<{ id: string }>
  /** Cập nhật subtotal/grandTotal sau khi trừ phí gửi xe */
  updateInvoiceTotals(invoiceId: string, subtotal: number, grandTotal: number): Promise<void>
  /** Invoice + items + stockMovements + payments + membershipPayments — cho edit-in-place */
  findByIdForEdit(invoiceId: string): Promise<EditInvoiceTarget | null>
  deleteInvoiceItems(invoiceId: string): Promise<void>
  deletePayments(invoiceId: string): Promise<void>
  updateInvoiceFinancials(invoiceId: string, input: UpdateInvoiceFinancialsInput): Promise<void>
  /** Invoice chi tiết (deep include) — GET /api/invoices/[id] */
  findByIdWithDetails(invoiceId: string): Promise<InvoiceDetail | null>
  /** Các hoá đơn của khách hàng (deep include) — GET /api/customers/[id]/history */
  findInvoicesByCustomer(customerId: string): Promise<CustomerInvoiceHistory[]>
  /** Invoice tối giản — cho DELETE guard */
  findByIdForDelete(invoiceId: string): Promise<InvoiceDeleteTarget | null>
  /** Đếm payment/stockMovement gắn invoice — INVOICE_LINKED guard */
  countLinkedTransactions(invoiceId: string): Promise<{ payments: number; stockMovements: number }>
  /** Xoá items + invoice (chỉ gọi khi không có giao dịch liên quan) */
  deleteInvoiceWithItems(invoiceId: string): Promise<void>
  /** Đếm hoá đơn PAID đã thanh toán của 1 session — xác định số lần thu trước ("lần n") */
  countPaidBySession(sessionId: string): Promise<number>
}
