// ── Adapter: implement BillingRepository bằng Prisma ─────
import type { BillingStore, ProductStore } from '../store-types'
import type {
  BillingRepository,
  VoidInvoiceItemRef,
  VoidInvoiceTarget,
} from '@/lib/invoicing/ports'

type BillingAdapterStore = BillingStore & ProductStore

export function createBillingRepository(store: BillingAdapterStore): BillingRepository {
  return {
    async findVoidTarget(invoiceId) {
      const invoice = await store.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          invoiceNo: true,
          grandTotal: true,
          status: true,
          notes: true,
          shiftId: true,
          sessionId: true,
          items: {
            select: {
              id: true,
              type: true,
              productId: true,
              stockMovements: {
                where: { type: 'SALE' },
                select: {
                  id: true,
                  productId: true,
                  quantity: true,
                },
              },
            },
          },
          staff: { select: { fullName: true } },
        },
      })
      if (!invoice) return null
      return {
        ...invoice,
        grandTotal: Number(invoice.grandTotal),
        items: invoice.items.map((item) => ({
          ...item,
          stockMovements: item.stockMovements,
        })),
      } satisfies VoidInvoiceTarget
    },

    async findMergedDraftItems(sessionId, invoiceNo): Promise<VoidInvoiceItemRef[]> {
      const mergedDrafts = await store.invoice.findMany({
        where: {
          sessionId,
          status: 'CANCELLED',
          notes: { contains: `Đã gộp vào hóa đơn ${invoiceNo}` },
        },
        select: {
          items: {
            select: {
              id: true,
              type: true,
              productId: true,
              stockMovements: {
                where: { type: 'SALE' },
                select: { id: true, productId: true, quantity: true },
              },
            },
          },
        },
      })
      return mergedDrafts
        .flatMap((d) => d.items)
        .map((item) => ({
          ...item,
          stockMovements: item.stockMovements,
        }))
    },

    async reverseStock(input) {
      await store.product.update({
        where: { id: input.productId },
        data: { stockQuantity: { increment: input.quantity } },
      })
      await store.stockMovement.create({
        data: {
          productId: input.productId,
          invoiceItemId: input.invoiceItemId,
          shiftId: input.shiftId,
          staffId: input.staffId,
          type: 'VOID',
          quantity: input.quantity,
          reason: input.reason,
        },
      })
    },

    async markInvoiceCancelled(invoiceId, notes) {
      await store.invoice.update({
        where: { id: invoiceId },
        data: { status: 'CANCELLED', notes },
      })
    },

    async createPaidInvoice(input) {
      const invoice = await store.invoice.create({
        data: {
          invoiceNo: input.invoiceNo,
          sessionId: input.sessionId ?? null,
          customerId: input.customerId,
          shiftId: input.shiftId,
          staffId: input.staffId,
          status: 'PAID',
          subtotal: input.subtotal,
          discountTotal: input.discountTotal,
          grandTotal: input.grandTotal,
          paidAt: input.paidAt,
          notes: input.notes,
          items: {
            create: input.lines.map((line) => ({
              type: line.type,
              description: line.description,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              subtotal: line.subtotal,
              discountAmount: line.discountAmount,
              total: line.total,
              metadata: line.metadata,
            })),
          },
        },
      })
      return { id: invoice.id, invoiceNo: invoice.invoiceNo }
    },

    async createPayment(input) {
      const payment = await store.payment.create({
        data: {
          kind: 'OPERATIONAL',
          invoiceId: input.invoiceId,
          sessionId: input.sessionId ?? null,
          shiftId: input.shiftId,
          staffId: input.staffId,
          totalHours: input.totalHours,
          subtotal: input.subtotal,
          discountTotal: input.discountTotal,
          grandTotal: input.grandTotal,
          paymentMethod: input.paymentMethod,
          paidAt: input.paidAt,
          notes: input.notes,
        },
      })
      return { id: payment.id }
    },

    async createMembershipPayment(input) {
      // STI: phí hội viên là Payment kind=MEMBERSHIP (gộp từ MembershipPayment cũ)
      const payment = await store.payment.create({
        data: {
          kind: 'MEMBERSHIP',
          customerId: input.customerId,
          membershipId: input.membershipId,
          planId: input.planId,
          invoiceId: input.invoiceId,
          shiftId: input.shiftId,
          staffId: input.staffId,
          totalHours: 0,
          subtotal: input.amount,
          discountTotal: 0,
          grandTotal: input.amount,
          paymentMethod: input.paymentMethod,
          paidAt: input.paidAt,
          notes: input.notes,
        },
      })
      return { id: payment.id }
    },

    async createInvoiceItem(input) {
      const item = await store.invoiceItem.create({
        data: {
          invoiceId: input.invoiceId,
          productId: input.productId ?? null,
          type: input.type,
          description: input.description,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          subtotal: input.subtotal,
          discountAmount: input.discountAmount,
          total: input.total,
          metadata: input.metadata,
        },
      })
      return { id: item.id }
    },

    async updateInvoiceTotals(invoiceId, subtotal, grandTotal) {
      await store.invoice.update({
        where: { id: invoiceId },
        data: { subtotal, grandTotal },
      })
    },

    async findByIdForEdit(invoiceId) {
      const invoice = await store.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          invoiceNo: true,
          status: true,
          shiftId: true,
          customerId: true,
          sessionId: true,
          paidAt: true,
          notes: true,
          subtotal: true,
          discountTotal: true,
          grandTotal: true,
          staff: { select: { fullName: true } },
          items: {
            select: {
              id: true,
              type: true,
              productId: true,
              description: true,
              quantity: true,
              unitPrice: true,
              subtotal: true,
              discountAmount: true,
              total: true,
              metadata: true,
              stockMovements: {
                where: { type: 'SALE' },
                select: {
                  id: true,
                  productId: true,
                  quantity: true,
                },
              },
            },
          },
          payments: {
            select: { id: true, totalHours: true, paymentMethod: true, kind: true },
          },
        },
      })
      if (!invoice) return null

      const toNum = (v: unknown): number => Number(v ?? 0)
      return {
        ...invoice,
        subtotal: toNum(invoice.subtotal),
        discountTotal: toNum(invoice.discountTotal),
        grandTotal: toNum(invoice.grandTotal),
        items: invoice.items.map((item) => ({
          ...item,
          quantity: toNum(item.quantity),
          unitPrice: toNum(item.unitPrice),
          subtotal: toNum(item.subtotal),
          discountAmount: toNum(item.discountAmount),
          total: toNum(item.total),
          stockMovements: item.stockMovements.map((m) => ({
            ...m,
            quantity: toNum(m.quantity),
          })),
        })),
        payments: invoice.payments.map((p) => ({
          ...p,
          totalHours: p.totalHours !== null ? Number(p.totalHours) : null,
        })),
      }
    },

    async deleteInvoiceItems(invoiceId) {
      await store.invoiceItem.deleteMany({ where: { invoiceId } })
    },

    async deletePayments(invoiceId) {
      // Chỉ xóa payment vận hành — phí hội viên (kind=MEMBERSHIP) không bị ảnh hưởng bởi edit-invoice
      await store.payment.deleteMany({ where: { invoiceId, kind: 'OPERATIONAL' } })
    },

    async updateInvoiceFinancials(invoiceId, input) {
      await store.invoice.update({
        where: { id: invoiceId },
        data: {
          subtotal: input.subtotal,
          discountTotal: input.discountTotal,
          grandTotal: input.grandTotal,
          notes: input.notes,
        },
      })
    },

    async findByIdWithDetails(invoiceId) {
      return store.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          customer: { select: { id: true, fullName: true, phone: true, type: true } },
          session: { select: { id: true, startTime: true, endTime: true, status: true, customerName: true, customerPhone: true, totalPausedSeconds: true } },
          shift: { select: { id: true, openedAt: true, closedAt: true } },
          staff: { select: { id: true, fullName: true } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, type: true } } },
            orderBy: { createdAt: 'asc' },
          },
          payments: {
            include: {
              staff: { select: { id: true, fullName: true } },
              membership: { include: { plan: { select: { name: true } } } },
              plan: { select: { id: true, name: true } },
              session: { select: { id: true, customerName: true, customerPhone: true } },
            },
          },
        },
      })
    },

    async findInvoicesByCustomer(customerId) {
      return store.invoice.findMany({
        where: { customerId },
        include: {
          session: { select: { id: true, startTime: true, endTime: true, status: true, customerName: true, totalHours: true, totalAmount: true } },
          shift: { select: { id: true, openedAt: true, status: true } },
          staff: { select: { id: true, fullName: true } },
          items: {
            select: {
              id: true,
              type: true,
              description: true,
              quantity: true,
              unitPrice: true,
              subtotal: true,
              discountAmount: true,
              total: true,
              product: { select: { id: true, name: true, type: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
          payments: {
            select: {
              id: true,
              kind: true,
              paymentMethod: true,
              grandTotal: true,
              paidAt: true,
              plan: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { paidAt: 'desc' },
      })
    },

    async findByIdForDelete(invoiceId) {
      const invoice = await store.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          invoiceNo: true,
          status: true,
          grandTotal: true,
          staffId: true,
          customerId: true,
          items: { select: { id: true } },
        },
      })
      if (!invoice) return null
      return { ...invoice, grandTotal: Number(invoice.grandTotal) }
    },

    async countLinkedTransactions(invoiceId) {
      const [payments, stockMovements] = await Promise.all([
        store.payment.count({ where: { invoiceId } }),
        store.stockMovement.count({ where: { invoiceItem: { invoiceId } } }),
      ])
      return { payments, stockMovements }
    },

    async deleteInvoiceWithItems(invoiceId) {
      await store.invoiceItem.deleteMany({ where: { invoiceId } })
      await store.invoice.delete({ where: { id: invoiceId } })
    },

    async countPaidBySession(sessionId) {
      return store.invoice.count({ where: { sessionId, status: 'PAID' } })
    },
  }
}
