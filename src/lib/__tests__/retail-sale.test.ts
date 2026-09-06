import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeStore = vi.hoisted(() => ({
  session: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  sessionPricingGroup: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  sessionPlayer: { createMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  sessionSellItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  shift: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  shiftParticipant: { create: vi.fn() },
  product: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  stockMovement: { create: vi.fn() },
  invoice: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  invoiceItem: { create: vi.fn(), findMany: vi.fn() },
  payment: { create: vi.fn(), findMany: vi.fn() },
  membership: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  membershipPlan: { findUnique: vi.fn(), findMany: vi.fn() },
  customer: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  appSetting: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  pricingRule: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  pricingTier: { findMany: vi.fn(), create: vi.fn() },
  promotionRule: { findUnique: vi.fn(), findMany: vi.fn() },
  activityLog: { create: vi.fn() },
  tool: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  shiftTool: { findUnique: vi.fn(), upsert: vi.fn() },
  cashflowEntry: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), findMany: vi.fn() },
  user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
}))

vi.mock('@/lib/infrastructure/prisma', () => ({
  prisma: { $transaction: (work: (store: unknown) => Promise<unknown>) => work(fakeStore) },
}))

import { retailSale } from '@/lib/invoicing/use-cases/retail-sale'
import { createRepositories } from '@/lib/infrastructure/repositories'

const repos = createRepositories(fakeStore as never)

function resetMocks() {
  vi.clearAllMocks()

  // Ca quầy đang mở
  fakeStore.shift.findFirst.mockResolvedValue({ id: 'shift-1', status: 'OPEN' })

  // Sản phẩm
  fakeStore.product.findMany.mockResolvedValue([
    { id: 'prod-1', name: 'Nước suối', type: 'PRODUCT', price: 10000, stockQuantity: 10, isActive: true },
  ])
  fakeStore.product.findUnique.mockResolvedValue({
    id: 'prod-1', name: 'Nước suối', type: 'PRODUCT', price: 10000, stockQuantity: 10, isActive: true,
  })

  // Invoice PAID + items + payment
  fakeStore.invoice.create.mockResolvedValue({ id: 'inv-1', invoiceNo: 'INV-20260825-1' })
  fakeStore.invoiceItem.create.mockResolvedValue({ id: 'item-1' })
  fakeStore.payment.create.mockResolvedValue({ id: 'pay-1' })

  fakeStore.product.updateMany.mockResolvedValue({ count: 1 })
}

const input = {
  staffId: 'staff-1',
  items: [{ productId: 'prod-1', quantity: 2 }],
  paymentMethod: 'CASH' as const,
  customerId: null,
}

describe('retailSale', () => {
  beforeEach(resetMocks)

  it('tạo invoice PAID + payment + trừ kho + audit trong 1 transaction', async () => {
    const result = await retailSale(input, repos)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ invoiceId: 'inv-1', grandTotal: 20000 })

    // Invoice PAID — không sessionId
    const invoiceCall = fakeStore.invoice.create.mock.calls[0][0]
    expect(invoiceCall.data).toMatchObject({ status: 'PAID', grandTotal: 20000 })
    expect(invoiceCall.data.sessionId).toBeNull()

    // InvoiceItem
    const itemCall = fakeStore.invoiceItem.create.mock.calls[0][0]
    expect(itemCall.data).toMatchObject({ productId: 'prod-1', quantity: 2, unitPrice: 10000 })

    // Trừ kho
    expect(fakeStore.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'prod-1', stockQuantity: { gte: 2 } },
      data: { stockQuantity: { decrement: 2 } },
    })

    // Stock movement SALE gắn invoiceItem
    const movementCall = fakeStore.stockMovement.create.mock.calls[0][0]
    expect(movementCall.data).toMatchObject({ type: 'SALE', quantity: -2, productId: 'prod-1', invoiceItemId: 'item-1' })

    // Payment
    const paymentCall = fakeStore.payment.create.mock.calls[0][0]
    expect(paymentCall.data).toMatchObject({ kind: 'OPERATIONAL', paymentMethod: 'CASH', grandTotal: 20000, sessionId: null })

    // Audit
    expect(fakeStore.activityLog.create).toHaveBeenCalled()
  })

  it('tích luỹ chi tiêu khi có customerId', async () => {
    const result = await retailSale({ ...input, customerId: 'cust-1' }, repos)
    expect(result.ok).toBe(true)
    // addSpend qua customer.update (totalSpent increment)
    expect(fakeStore.customer.update).toHaveBeenCalled()
  })

  it('trả INSUFFICIENT_STOCK khi không đủ tồn', async () => {
    fakeStore.product.updateMany.mockResolvedValue({ count: 0 })
    const result = await retailSale(input, repos)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_STOCK')
  })

  it('trả SHIFT_REQUIRED khi chưa có ca mở', async () => {
    fakeStore.shift.findFirst.mockResolvedValue(null)
    const result = await retailSale(input, repos)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SHIFT_REQUIRED')
  })

  it('trả PRODUCT_NOT_FOUND khi sản phẩm không tồn tại', async () => {
    fakeStore.product.findMany.mockResolvedValue([])
    const result = await retailSale(input, repos)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PRODUCT_NOT_FOUND')
  })
})
