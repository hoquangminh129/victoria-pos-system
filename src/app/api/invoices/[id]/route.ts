import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireMutationAuth } from '@/lib/shared/auth'
import { isAdminOnly } from '@/lib/shared/roles'
import { deleteInvoice, mapDeleteInvoiceError } from '@/lib/invoicing'
import { repositories } from '@/lib/infrastructure/repositories'
import {
  apiSuccess,
  apiError,
  ERR_UNAUTHORIZED,
  ERR_FORBIDDEN,
  ERR_CSRF,
} from '@/lib/infrastructure/api-helpers'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth()
    const { id } = await params

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json(
        { success: false, error: 'ID hoá đơn không hợp lệ' },
        { status: 400 }
      )
    }

    const invoice = await repositories.billing.findByIdWithDetails(id)

    if (!invoice) {
      return apiError({ code: 'INVOICE_NOT_FOUND', message: 'Không tìm thấy hoá đơn', status: 404 })
    }

    const isAdmin = auth.role === 'ADMIN' || auth.role === 'MANAGER'
    const isOwner = invoice.staffId === auth.userId
    if (!isAdmin && !isOwner) {
      return apiError({ code: 'FORBIDDEN', message: 'Không có quyền xem hoá đơn này', status: 403 })
    }

    // Khách vãng lai nằm trên Session. Hoá đơn cũ có Invoice.sessionId = null
    // (createPaidInvoice từng không ghi cột này) → suy phiên từ Payment.sessionId.
    const paySession =
      invoice.payments.map((p) => p.session).find((s) => s?.customerName || s?.customerPhone) ?? null
    const walkInName = invoice.session?.customerName ?? paySession?.customerName ?? null
    const walkInPhone = invoice.session?.customerPhone ?? paySession?.customerPhone ?? null

    return apiSuccess({
        id: invoice.id,
        invoiceNo: invoice.invoiceNo,
        status: invoice.status,
        subtotal: Number(invoice.subtotal),
        discountTotal: Number(invoice.discountTotal),
        grandTotal: Number(invoice.grandTotal),
        paidAt: invoice.paidAt?.toISOString() ?? null,
        notes: invoice.notes,
        createdAt: invoice.createdAt.toISOString(),
        customer: invoice.customer
          ? {
              id: invoice.customer.id,
              fullName: invoice.customer.fullName,
              phone: invoice.customer.phone,
              type: invoice.customer.type,
            }
          : walkInName
            ? {
                id: null,
                fullName: walkInName,
                phone: walkInPhone,
                type: 'WALK_IN' as const,
              }
            : null,
        session: invoice.session
          ? {
              id: invoice.session.id,
              startTime: invoice.session.startTime.toISOString(),
              endTime: invoice.session.endTime?.toISOString() ?? null,
              status: invoice.session.status,
              totalPausedSeconds: invoice.session.totalPausedSeconds ?? 0,
            }
          : null,
        shift: invoice.shift
          ? {
              id: invoice.shift.id,
              openedAt: invoice.shift.openedAt.toISOString(),
              closedAt: invoice.shift.closedAt?.toISOString() ?? null,
            }
          : null,
        staff: { id: invoice.staff.id, fullName: invoice.staff.fullName },
        items: invoice.items.map((item) => ({
          id: item.id,
          type: item.type,
          description: item.description,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          subtotal: Number(item.subtotal),
          discountAmount: Number(item.discountAmount),
          total: Number(item.total),
          product: item.product
            ? { id: item.product.id, name: item.product.name, sku: item.product.sku, type: item.product.type }
            : null,
          metadata: item.metadata,
        })),
        payments: invoice.payments.map((payment) => ({
          id: payment.id,
          kind: payment.kind,
          paymentMethod: payment.paymentMethod,
          grandTotal: Number(payment.grandTotal),
          paidAt: payment.paidAt.toISOString(),
          notes: payment.notes,
          staff: { id: payment.staff.id, fullName: payment.staff.fullName },
        })),
        // STI: phí hội viên là Payment kind=MEMBERSHIP — giữ shape cũ cho frontend
        membershipPayments: invoice.payments
          .filter((p) => p.kind === 'MEMBERSHIP')
          .map((mp) => ({
            id: mp.id,
            amount: Number(mp.grandTotal),
            paidAt: mp.paidAt.toISOString(),
            planName: mp.membership?.plan?.name ?? mp.plan?.name ?? null,
          })),
      })
  } catch (error) {
    if ((error as Error).message === 'UNAUTHORIZED') {
      return NextResponse.json({ success: false, error: 'Chưa đăng nhập' }, { status: 401 })
    }
    console.error('GET /api/invoices/[id] error:', error)
    return NextResponse.json({ success: false, error: 'Lỗi máy chủ' }, { status: 500 })
  }
}

// ── DELETE /api/invoices/[id] ──────────────────────────────
// Chỉ quản trị viên được xoá hoá đơn. Để bảo toàn dấu mốc kế toán,
// chỉ cho phép xoá hoá đơn chưa có bất kỳ giao dịch tài chính nào liên
// quan (không có thanh toán, phí hội viên, hay biến động tồn kho).
// Hành động xoá luôn được ghi lại trong nhật ký hoạt động.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireMutationAuth(request)
    if (!isAdminOnly(auth.role)) return apiError(ERR_FORBIDDEN)
    const { id } = await params

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return apiError({ code: 'INVALID_ID', message: 'ID hoá đơn không hợp lệ', status: 400 })
    }

    const result = await deleteInvoice({ invoiceId: id, staffId: auth.userId, role: auth.role })
    if (!result.ok) return apiError(mapDeleteInvoiceError(result.error))

    return apiSuccess({ message: 'Đã xoá hoá đơn' })
  } catch (error) {
    const message = (error as Error).message
    if (message === 'UNAUTHORIZED') return apiError(ERR_UNAUTHORIZED)
    if (message === 'CSRF_MISMATCH') return apiError(ERR_CSRF)
    if (message === 'FORBIDDEN') return apiError({ code: 'FORBIDDEN', message: 'Chỉ quản trị viên được xoá hoá đơn', status: 403 })
    console.error('DELETE /api/invoices/[id] error:', error)
    return apiError({ code: 'UNKNOWN', message: 'Lỗi máy chủ', status: 500 })
  }
}
