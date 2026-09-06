import { describe, it, expect, vi } from 'vitest'

// Mock prisma singleton — check-out.ts import runInTransaction (db-helpers → prisma).
// Test runCheckOutTx trực tiếp với fake repositories, không chạy transaction thật.
vi.mock('@/lib/infrastructure/prisma', () => ({ prisma: {} }))

import { runCheckOutTx, mapCheckoutError, type CheckoutContext, type CheckoutTxState } from '@/lib/sessions/use-cases/check-out'
import { RollbackSignal } from '@/lib/infrastructure/db-helpers'
import type { Repositories } from '@/lib/infrastructure/repositories'
import type { SessionWithPlayers } from '@/lib/sessions/ports'

function makeSession(): SessionWithPlayers {
  return {
    id: 'session-1',
    customerId: 'cust-1',
    customerName: null,
    membershipId: null,
    staffId: 'staff-1',
    shiftId: 'shift-1',
    startTime: new Date('2026-08-07T10:00:00Z'),
    endTime: null,
    status: 'ACTIVE',
    playerCount: 2,
    hourlyRate: 50000,
    customer: { id: 'cust-1', fullName: 'Khách A', type: 'WALK_IN' },
    membership: null,
    pricingGroups: [
      {
        id: 'group-1',
        label: 'Nhóm 1',
        playerCount: 2,
        remainingCount: 2,
        hourlyRate: 50000,
        pricingRuleId: 'rule-1',
        pricingSnapshot: null,
        players: [],
      },
    ],
  } as unknown as SessionWithPlayers
}

const pricing = {
  hourlyRate: 50000,
  tiers: [],
  totalHours: 2,
  subtotal: 100000,
  promotionDiscount: 0,
  grandTotal: 100000,
  isMemberSession: false,
  promotion: null,
}

function makeRepositories(overrides: Partial<Repositories> = {}): Repositories {
  const base: Repositories = {
    billing: {
      findVoidTarget: vi.fn(),
      findMergedDraftItems: vi.fn(),
      reverseStock: vi.fn(),
      markInvoiceCancelled: vi.fn(),
      createPaidInvoice: vi.fn(async () => ({ id: 'inv-1', invoiceNo: 'INV-1' })),
      createPayment: vi.fn(async () => ({ id: 'pay-1' })),
      createMembershipPayment: vi.fn(),
      createInvoiceItem: vi.fn(async () => ({ id: 'item-1' })),
      updateInvoiceTotals: vi.fn(),
      findByIdForEdit: vi.fn(),
      deleteInvoiceItems: vi.fn(),
      deletePayments: vi.fn(),
      updateInvoiceFinancials: vi.fn(),
      findByIdWithDetails: vi.fn(),
      findByIdForDelete: vi.fn(),
      countLinkedTransactions: vi.fn(async () => ({ payments: 0, stockMovements: 0 })),
      deleteInvoiceWithItems: vi.fn(),
      findInvoicesByCustomer: vi.fn(),
      countPaidBySession: vi.fn(async () => 0),
    },
    audit: { append: vi.fn(async () => {}), findMany: vi.fn() },
    membership: { findLatest: vi.fn(), findActive: vi.fn(), create: vi.fn(), findManyByCustomer: vi.fn() },
    membershipPlan: { findById: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), countUsage: vi.fn(), delete: vi.fn() },
    customer: { findById: vi.fn(), findByIdIncludingDeleted: vi.fn(), findByIdWithCount: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn(), softDelete: vi.fn(), addSpend: vi.fn(), recordPlay: vi.fn(), findByPhone: vi.fn(), countWalkInsBetween: vi.fn() },
    shift: {
      findOpenForStaff: vi.fn(async () => ({ id: 'shift-1' }) as never),
      findOpenOperational: vi.fn(),
      findByIdForClose: vi.fn(),
      calculateExpectedCash: vi.fn(),
      markParticipantsLeft: vi.fn(),
      upsertToolCloseCount: vi.fn(),
      upsertToolOpenCount: vi.fn(),
      close: vi.fn(),
      upsertParticipant: vi.fn(),
      findByIdOrThrow: vi.fn(),
      createWithLead: vi.fn(),
      findByIdWithToolStats: vi.fn(),
      findByIdAccess: vi.fn(),
      findManyWithCount: vi.fn(),
      findByIdExport: vi.fn(),
      adjustCashDifference: vi.fn(),
    },
    pricing: {
      findApplicableRule: vi.fn(),
      findByIdWithTiers: vi.fn(),
      getApplicableRules: vi.fn(),
      countApplicable: vi.fn(),
      countAll: vi.fn(),
      findOverlapping: vi.fn(),
      findManyWithTiers: vi.fn(),
      findById: vi.fn(),
      createWithTiers: vi.fn(),
      update: vi.fn(),
      deleteTiersByRule: vi.fn(),
      createTiers: vi.fn(),
      delete: vi.fn(),
    },
    promotions: { findAvailable: vi.fn(), findAvailableById: vi.fn(), findOverlapping: vi.fn(), findMany: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    settings: { get: vi.fn(), getNumeric: vi.fn(async () => 0), upsert: vi.fn(), getWithLabel: vi.fn(), findAll: vi.fn() },
    session: {
      findByIdForCheckout: vi.fn(),
      findByIdWithCustomer: vi.fn(),
      findActiveByCustomer: vi.fn(),
      findMany: vi.fn(),
      findByIdForPreview: vi.fn(),
      findSellItemTotals: vi.fn(async () => ({})),
      findSellItems: vi.fn(async () => []),
      addSellItem: vi.fn(async () => {}),
      removeSellItems: vi.fn(async () => {}),
      clearSellItems: vi.fn(async () => {}),
      countCreatedBetween: vi.fn(async () => 0),
      createWithRefs: vi.fn(),
      createPricingGroup: vi.fn(async () => ({ id: 'group-1' })),
      createPlayersForGroup: vi.fn(async () => {}),
      updatePricingGroup: vi.fn(),
      update: vi.fn(async () => {}),
      decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 0 })),
      sumRemainingPlayers: vi.fn(async () => 0),
      findByIdWithPlayers: vi.fn(),
      findPlayersForPause: vi.fn(),
      pausePlayer: vi.fn(async () => {}),
      resumePlayer: vi.fn(async () => {}),
      pausePlayersForSession: vi.fn(async () => {}),
      resumePlayersForSession: vi.fn(async () => {}),
      renamePlayer: vi.fn(),
      movePlayersToGroup: vi.fn(async () => {}),
      markPlayersCheckedOut: vi.fn(async () => {}),
    },
    product: {
      findManyByIds: vi.fn(),
      findByIdForSale: vi.fn(async () => ({
        id: 'prod-1',
        name: 'Nước suối',
        type: 'PRODUCT' as const,
        price: 15000,
        stockQuantity: 10,
        isActive: true,
      })),
      decrementStockIfAvailable: vi.fn(async () => ({ count: 1 })),
      recordSaleMovement: vi.fn(async () => {}),
      findManyForAdmin: vi.fn(),
      findByIdAdmin: vi.fn(),
      createWithInitialStock: vi.fn(),
      applyStockMovement: vi.fn(),
      deactivate: vi.fn(),
      delete: vi.fn(),
      countUsage: vi.fn(),
    },
    cashflow: {
      create: vi.fn(),
      findById: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => ({ entries: [], total: 0, page: 1, pageSize: 10 })),
      summarize: vi.fn(),
    },
    user: { findByUsername: vi.fn(), findById: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), findActiveOpenShiftParticipants: vi.fn() },
    tool: { findMany: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    student: { findMany: vi.fn(), findById: vi.fn(), findByIdIncludingDeleted: vi.fn(), create: vi.fn(), update: vi.fn(), softDelete: vi.fn() },
    lesson: { findManyBetween: vi.fn(), findById: vi.fn(), findBySeries: vi.fn(), findUpcomingByStudent: vi.fn(), findPastByStudent: vi.fn(), create: vi.fn(), update: vi.fn(), cancel: vi.fn(), setGoogleEventId: vi.fn(), deleteFutureBySeries: vi.fn(), countLessonsByStudent: vi.fn(), upsertAttendance: vi.fn(), setPackage: vi.fn() },
    lessonSeries: { findById: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    lessonPackage: { findById: vi.fn(), findActiveByStudent: vi.fn(), create: vi.fn(), update: vi.fn(), incrementUsed: vi.fn() },
    calendarConnection: { find: vi.fn(async () => null), upsert: vi.fn(), updateToken: vi.fn(), delete: vi.fn() },
    reporting: {
      getDashboardData: vi.fn(),
      getRevenueData: vi.fn(),
      getRevenueExportRows: vi.fn(),
      getSessionExportRows: vi.fn(),
      getShiftDayGroups: vi.fn(),
      getShiftRevenue: vi.fn(),
      getShiftRevenues: vi.fn(),
      getTrends: vi.fn(),
      getTopProducts: vi.fn(),
    },
  }
  return { ...base, ...overrides }
}

function makeCtx(): CheckoutContext {
  return {
    session: makeSession(),
    sessionId: 'session-1',
    staffId: 'staff-1',
    paymentMethod: 'CASH',
    endTime: new Date('2026-08-07T12:00:00Z'),
    notes: undefined,
    checkoutCount: 1,
    targetGroupId: 'group-1',
    pricing,
    checkoutLines: [
      { productId: 'prod-1', type: 'PRODUCT', description: 'Nước suối', quantity: 2, unitPrice: 15000, subtotal: 30000 },
    ],
    productSubtotal: 30000,
    mergedSellItemIds: [],
    sellItemLines: [],
    newQuantityByProductId: new Map([['prod-1', 2]]),
    parkingVehicleCount: 0,
    checkoutAt: new Date('2026-08-07T12:00:00Z'),
    pauseRef: new Date('2026-08-07T12:00:00Z'),
    customerId: 'cust-1',
    customerName: null,
    playersToBill: [],
  }
}

function makeState(): CheckoutTxState {
  return {
    finalPricing: pricing,
    playDiscountTotal: 0,
    playTotal: 100000,
    invoiceSubtotal: 130000,
    invoiceGrandTotal: 130000,
    paidAt: new Date('2026-08-07T12:00:00Z'),
  }
}

async function expectTxError(repos: Repositories, code: string) {
  let caught: RollbackSignal | null = null
  try {
    await runCheckOutTx(repos, makeCtx(), makeState())
  } catch (error) {
    if (error instanceof RollbackSignal) caught = error
    else throw error
  }
  expect(caught?.error.code).toBe(code)
}

describe('runCheckOutTx', () => {
  it('trả SHIFT_REQUIRED khi chưa có ca mở', async () => {
    const repos = makeRepositories({
      shift: {
        ...makeRepositories().shift,
        findOpenForStaff: vi.fn(async () => null),
      },
    })
    await expectTxError(repos, 'SHIFT_REQUIRED')
    expect(repos.billing.createPaidInvoice).not.toHaveBeenCalled()
  })

  it('trả INSUFFICIENT_STOCK kèm tên sản phẩm khi trừ kho thất bại', async () => {
    const repos = makeRepositories({
      product: {
        ...makeRepositories().product,
        decrementStockIfAvailable: vi.fn(async () => ({ count: 0 })),
      },
    })
    let caught: RollbackSignal | null = null
    try {
      await runCheckOutTx(repos, makeCtx(), makeState())
    } catch (error) {
      if (error instanceof RollbackSignal) caught = error
      else throw error
    }
    expect(caught?.error.code).toBe('INSUFFICIENT_STOCK')
    expect(caught?.error.detail).toBe('Nước suối')
  })

  it('trả PROMOTION_UNAVAILABLE khi promotion không còn hiệu lực trong tx', async () => {
    const repos = makeRepositories({
      promotions: {
        ...makeRepositories().promotions,
        findAvailableById: vi.fn(async () => null),
      },
    })
    const state = makeState()
    state.promotionRuleId = 'promo-1'
    let caught: RollbackSignal | null = null
    try {
      await runCheckOutTx(repos, makeCtx(), state)
    } catch (error) {
      if (error instanceof RollbackSignal) caught = error
      else throw error
    }
    expect(caught?.error.code).toBe('PROMOTION_UNAVAILABLE')
  })

  it('checkout thành công: invoice + PLAY_TIME + payment + đóng phiên + audit', async () => {
    const repos = makeRepositories()
    const result = await runCheckOutTx(repos, makeCtx(), makeState())

    // Invoice PAID với tổng = playTotal (1 người) + sản phẩm
    expect(repos.billing.createPaidInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cust-1',
        subtotal: 130000,
        discountTotal: 0,
        grandTotal: 130000,
      })
    )

    // PLAY_TIME item + PRODUCT item
    const items = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls
    const playTimeCall = items.find((c) => c[0].type === 'PLAY_TIME')
    const productCall = items.find((c) => c[0].type === 'PRODUCT')
    expect(playTimeCall).toBeDefined()
    expect(playTimeCall![0]).toMatchObject({
      quantity: 2, // totalHours 2 × checkoutCount 1
      unitPrice: 50000,
      total: 100000,
      description: 'Giờ chơi (Nhóm 1: 1 người × 50kđ)',
    })
    expect(productCall![0]).toMatchObject({ productId: 'prod-1', quantity: 2, total: 30000 })

    // Trừ kho + ghi movement
    expect(repos.product.decrementStockIfAvailable).toHaveBeenCalledWith('prod-1', 2)
    expect(repos.product.recordSaleMovement).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'prod-1', quantity: 2 })
    )

    // Payment
    expect(repos.billing.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv-1', sessionId: 'session-1', grandTotal: 130000 })
    )

    // Group decrement + session COMPLETED (sumRemaining = 0)
    expect(repos.session.decrementGroupRemaining).toHaveBeenCalledWith('group-1', 1)
    expect(repos.session.update).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ status: 'COMPLETED', totalAmount: 130000 })
    )

    // Customer stats + audit
    expect(repos.customer.recordPlay).toHaveBeenCalledWith('cust-1', { hours: 2, spent: 130000 })
    expect(repos.audit.append).toHaveBeenCalledTimes(1)
    const auditCall = (repos.audit.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(auditCall.action).toBe('SESSION_CHECK_OUT')

    expect(result.remainingPlayers).toBe(0)
    expect(result.invoiceNo).toBe('INV-1')
  })

  it('checkout khách vãng lai (không Customer): không gọi recordPlay, invoice customerId null', async () => {
    const repos = makeRepositories()
    const session = makeSession()
    session.customerId = null
    session.customerName = 'Nguyễn Văn A'
    session.customer = null as never
    const ctx = makeCtx()
    ctx.session = session
    ctx.customerId = null
    ctx.customerName = 'Nguyễn Văn A'
    const result = await runCheckOutTx(repos, ctx, makeState())

    expect(repos.billing.createPaidInvoice).toHaveBeenCalledWith(
      // sessionId phải được ghi để UI hoá đơn đọc được tên/SĐT khách vãng lai từ phiên
      expect.objectContaining({ customerId: null, sessionId: 'session-1' })
    )
    expect(repos.customer.recordPlay).not.toHaveBeenCalled()
    // metadata PLAY_TIME có tên khách vãng lai
    const items = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls
    const playTimeCall = items.find((c) => c[0].type === 'PLAY_TIME')
    expect(playTimeCall![0].metadata).toMatchObject({ customerType: 'WALK_IN', customerName: 'Nguyễn Văn A' })
    expect(result.remainingPlayers).toBe(0)
  })

  it('không đóng phiên khi còn người chơi (partial checkout)', async () => {
    const repos = makeRepositories({
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 1 })),
        sumRemainingPlayers: vi.fn(async () => 1),
      },
    })
    const result = await runCheckOutTx(repos, makeCtx(), makeState())
    expect(result.remainingPlayers).toBe(1)
    expect(repos.session.update).not.toHaveBeenCalled()
  })

  it('trừ phí gửi xe khi parkingVehicleCount > 0 và có đơn giá', async () => {
    const repos = makeRepositories({
      settings: {
        ...makeRepositories().settings,
        getNumeric: vi.fn(async () => 5000),
      },
    })
    const ctx = makeCtx()
    ctx.parkingVehicleCount = 2
    const result = await runCheckOutTx(repos, ctx, makeState())

    // SURCHARGE item + grandTotal bị trừ 10.000
    const items = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls
    const surchargeCall = items.find((c) => c[0].type === 'SURCHARGE')
    expect(surchargeCall).toBeDefined()
    expect(surchargeCall![0]).toMatchObject({ quantity: 2, total: -10000 })
    expect(repos.billing.updateInvoiceTotals).toHaveBeenCalledWith('inv-1', 120000, 120000)
    expect(result.parkingFeeTotal).toBe(10000)
  })

  it('trả PRICING_GROUP_UNDERFLOW khi decrement nhóm xuống dưới 0', async () => {
    const repos = makeRepositories({
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: -1 })),
      },
    })
    await expectTxError(repos, 'PRICING_GROUP_UNDERFLOW')
  })

  it('trả END_TIME_BEFORE_START khi endTime trước startTime', async () => {
    // Guard này nằm ở entry `checkOut` (pre-tx), không trong runCheckOutTx.
    // Ta test qua mapCheckoutError cho mapper mapping đúng.
    const mapped = mapCheckoutError({ code: 'END_TIME_BEFORE_START' })
    expect(mapped.status).toBe(400)
    expect(mapped.code).toBe('END_TIME_BEFORE_START')
  })

  it('trả NO_PLAYERS_TO_CHECKOUT khi không còn người chơi để checkout', async () => {
    const mapped = mapCheckoutError({ code: 'NO_PLAYERS_TO_CHECKOUT' })
    expect(mapped.status).toBe(400)
    expect(mapped.code).toBe('NO_PLAYERS_TO_CHECKOUT')
  })

  it('mapCheckoutError: PRICING_GROUP_UNDERFLOW mapping thành 400 (bug fix)', async () => {
    const mapped = mapCheckoutError({ code: 'PRICING_GROUP_UNDERFLOW' })
    expect(mapped.status).toBe(400)
    expect(mapped.code).toBe('PRICING_GROUP_UNDERFLOW')
  })

  it('checkout khách vãng lai với pricing tiered: nhiều bậc giá', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    ctx.pricing = { ...pricing, totalHours: 5, subtotal: 250000, grandTotal: 250000 }
    const state = makeState()
    state.finalPricing = { ...pricing, totalHours: 5, subtotal: 250000, grandTotal: 250000 }
    state.playTotal = 250000
    state.invoiceSubtotal = 280000 // 250000 + 30000 product
    state.invoiceGrandTotal = 280000
    const result = await runCheckOutTx(repos, ctx, state)

    // PLAY_TIME quantity = totalHours 5 × checkoutCount 1, unitPrice = rate
    const items = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls
    const playTimeCall = items.find((c) => c[0].type === 'PLAY_TIME')
    expect(playTimeCall![0]).toMatchObject({
      quantity: 5,
      unitPrice: 50000,
      total: 250000,
    })
    expect(result.finalPricing.subtotal).toBe(250000)
  })

  it('checkout hội viên: PLAY_TIME với isMemberSession + total 0, không trừ kho', async () => {
    const repos = makeRepositories({
      membership: {
        ...makeRepositories().membership,
        findActive: vi.fn(async () => ({
          id: 'mem-1',
          customerId: 'cust-1',
          planId: 'plan-1',
          startsAt: new Date('2026-01-01'),
          expiresAt: new Date('2026-12-31'),
          status: 'ACTIVE' as const,
          plan: { id: 'plan-1', name: 'VIP', durationMonths: 12, price: 1000000, isActive: true, createdAt: new Date(), updatedAt: new Date() },
        }) as never),
      },
    })
    const session = makeSession()
    session.customer!.type = 'MEMBER'
    session.hourlyRate = 0 as never
    session.membership = {
      id: 'mem-1',
      customerId: 'cust-1',
      planId: 'plan-1',
      startsAt: new Date('2026-01-01'),
      expiresAt: new Date('2026-12-31'),
      status: 'ACTIVE' as const,
      plan: { id: 'plan-1', name: 'VIP', durationMonths: 12, price: 1000000, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    } as never
    const ctx = makeCtx()
    ctx.session = session
    ctx.pricing = { ...pricing, hourlyRate: 0, subtotal: 0, grandTotal: 0, isMemberSession: true }
    // Member checkout không kèm sản phẩm
    ctx.checkoutLines = []
    ctx.productSubtotal = 0
    ctx.newQuantityByProductId = new Map()
    const state = makeState()
    state.finalPricing = { ...pricing, hourlyRate: 0, subtotal: 0, grandTotal: 0, isMemberSession: true }
    state.playTotal = 0
    state.invoiceSubtotal = 30000 // chỉ product
    state.invoiceGrandTotal = 30000
    const result = await runCheckOutTx(repos, ctx, state)

    const items = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls
    const playTimeCall = items.find((c) => c[0].type === 'PLAY_TIME')
    expect(playTimeCall![0]).toMatchObject({
      quantity: 2,
      unitPrice: 0,
      total: 0,
      description: 'Giờ chơi hội viên × 1 người',
    })
    expect(repos.product.decrementStockIfAvailable).not.toHaveBeenCalled()
    expect(result.finalPricing.isMemberSession).toBe(true)
  })

  it('checkout full với sell items: gộp thành InvoiceItem + xoá dòng bán kèm', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    ctx.mergedSellItemIds = ['ssi-1', 'ssi-2']
    ctx.sellItemLines = [
      { id: 'ssi-1', productId: 'prod-1', quantity: 1, unitPrice: 15000 },
      { id: 'ssi-2', productId: 'prod-1', quantity: 1, unitPrice: 15000 },
    ]
    const result = await runCheckOutTx(repos, ctx, makeState())

    // Full checkout → xoá các dòng bán kèm đã gộp
    expect(repos.session.removeSellItems).toHaveBeenCalledWith(['ssi-1', 'ssi-2'])
    expect(result.remainingPlayers).toBe(0)
  })

  it('partial checkout với sell items: xoá dòng bán kèm đã gộp ngay để không tính lặp', async () => {
    const repos = makeRepositories({
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 1 })),
        sumRemainingPlayers: vi.fn(async () => 1),
      },
    })
    const ctx = makeCtx()
    ctx.mergedSellItemIds = ['ssi-1']
    ctx.sellItemLines = [
      { id: 'ssi-1', productId: 'prod-1', quantity: 1, unitPrice: 15000 },
    ]
    const result = await runCheckOutTx(repos, ctx, makeState())

    expect(result.remainingPlayers).toBe(1)
    expect(repos.session.removeSellItems).toHaveBeenCalledWith(['ssi-1'])
  })

  it('WALK_IN session chưa có giá: persist bảng giá vào group 1 trước khi tạo invoice', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    ctx.session = {
      ...makeSession(),
      hourlyRate: 0 as never,
      pricingGroups: [{
        id: 'group-1',
        label: 'Nhóm 1',
        playerCount: 2,
        remainingCount: 2,
        hourlyRate: 0,
        pricingRuleId: null,
        pricingSnapshot: null,
        players: [],
      }],
    } as unknown as SessionWithPlayers
    ctx.pendingAssignments = [{
      groupId: 'group-1',
      label: 'Nhóm 1',
      playerCount: 2,
      pricingRuleId: 'rule-1',
      snapshot: { ruleId: 'rule-1', name: 'Giờ vàng', ratePerHour: 50000, tiers: [] },
      playerIds: [],
    }]
    ctx.pricing = { ...pricing, hourlyRate: 50000 }
    const state = makeState()
    state.finalPricing = { ...pricing, hourlyRate: 50000 }
    const result = await runCheckOutTx(repos, ctx, state)

    expect(repos.session.updatePricingGroup).toHaveBeenCalledWith('group-1', expect.objectContaining({
      label: 'Nhóm 1',
      playerCount: 2,
      remainingCount: 2,
      hourlyRate: 50000,
      pricingRuleId: 'rule-1',
      pricingSnapshot: { ruleId: 'rule-1', name: 'Giờ vàng', ratePerHour: 50000, tiers: [] },
    }))
    expect(repos.session.createPricingGroup).not.toHaveBeenCalled()
    // Audit đánh dấu gán giá tại checkout
    const auditCall = (repos.audit.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(auditCall.details.pricingAssignedAtCheckout).toBe(true)
    expect(auditCall.details.assignedPricingRuleIds).toEqual(['rule-1'])
    expect(result.finalPricing.hourlyRate).toBe(50000)
  })

  it('WALK_IN chia nhóm tại checkout: update group 1 + create group 2..N', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    ctx.session = {
      ...makeSession(),
      hourlyRate: 0 as never,
      playerCount: 3,
      pricingGroups: [{
        id: 'group-1',
        label: 'Nhóm 1',
        playerCount: 3,
        remainingCount: 3,
        hourlyRate: 0,
        pricingRuleId: null,
        pricingSnapshot: null,
        players: [],
      }],
    } as unknown as SessionWithPlayers
    ctx.pendingAssignments = [
      { groupId: 'group-1', label: 'Nhóm 1', playerCount: 2, pricingRuleId: 'rule-1', snapshot: { ruleId: 'rule-1', name: 'Giờ vàng', ratePerHour: 50000, tiers: [] }, playerIds: [] },
      { groupId: null, label: 'Nhóm 2', playerCount: 1, pricingRuleId: 'rule-2', snapshot: { ruleId: 'rule-2', name: 'Giờ tối', ratePerHour: 40000, tiers: [] }, playerIds: [] },
    ]
    const state = makeState()
    state.finalPricing = { ...pricing, hourlyRate: 50000 }
    await runCheckOutTx(repos, ctx, state)

    expect(repos.session.updatePricingGroup).toHaveBeenCalledTimes(1)
    expect(repos.session.updatePricingGroup).toHaveBeenCalledWith('group-1', expect.objectContaining({
      playerCount: 2,
      remainingCount: 2,
      hourlyRate: 50000,
      pricingRuleId: 'rule-1',
    }))
    expect(repos.session.createPricingGroup).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      label: 'Nhóm 2',
      playerCount: 1,
      remainingCount: 1,
      hourlyRate: 40000,
      pricingRuleId: 'rule-2',
    }))
  })

  it('không persist bảng giá khi group đã có snapshot (session cũ)', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    ctx.pendingAssignments = undefined
    const result = await runCheckOutTx(repos, ctx, makeState())

    expect(repos.session.updatePricingGroup).not.toHaveBeenCalled()
    expect(repos.session.createPricingGroup).not.toHaveBeenCalled()
    const auditCall = (repos.audit.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(auditCall.details.pricingAssignedAtCheckout).toBe(false)
    expect(result.remainingPlayers).toBe(0)
  })

  it('mapCheckoutError: PRICING_RULE_NOT_FOUND + GROUP_PLAYER_COUNT_MISMATCH mapping', async () => {
    expect(mapCheckoutError({ code: 'PRICING_RULE_NOT_FOUND' } as never)).toMatchObject({ status: 400, message: expect.stringContaining('bảng giá') })
    expect(mapCheckoutError({ code: 'GROUP_PLAYER_COUNT_MISMATCH' } as never)).toMatchObject({ status: 400, message: expect.stringContaining('nhóm') })
    expect(mapCheckoutError({ code: 'PRICING_RULE_NOT_EFFECTIVE' } as never)).toMatchObject({ status: 400 })
  })

  it('PLAY_TIME metadata ghi pausedSeconds theo group khi có player paused', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    // Player 1 paused từ 11:30 (checkoutAt = 12:00 → 1800s), player 2 chạy
    ctx.session = {
      ...makeSession(),
      pricingGroups: [{
        ...makeSession().pricingGroups[0],
        players: [
          { id: 'player-1', name: null, pausedAt: new Date('2026-08-07T11:30:00Z'), totalPausedSeconds: 300, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date(), updatedAt: new Date() },
          { id: 'player-2', name: 'Minh', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date(), updatedAt: new Date() },
        ],
      }],
    } as unknown as SessionWithPlayers
    ctx.targetGroupId = 'group-1'
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    // Thu cả 2 player (checkoutCount mặc định 1 → set 2 để thu hết)
    ctx.checkoutCount = 2
    ctx.playersToBill = [
      { id: 'player-1', name: null, pausedAt: new Date('2026-08-07T11:30:00Z'), totalPausedSeconds: 300, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date(), updatedAt: new Date() },
      { id: 'player-2', name: 'Minh', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date(), updatedAt: new Date() },
    ] as unknown as CheckoutContext['playersToBill']
    const state = makeState()
    state.finalPricing = { ...pricing, totalHours: 1.5 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    // pausedSeconds = 300 (tích lũy) + 1800 (đang paused từ 11:30 → 12:00) = 2100
    expect(playItemCall[0].metadata.pausedSeconds).toBe(2100)
    expect(playItemCall[0].metadata.playerPauses).toEqual([
      { id: 'player-1', name: '', pausedSeconds: 2100 },
      { id: 'player-2', name: 'Minh', pausedSeconds: 0 },
    ])
  })

  it('per-player fallback session pause: phiên 1 người pause toàn phiên → player pause 0 → tính đúng (trừ pause)', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    // Phiên 1 người: session pause toàn phiên (900s tích lũy) — player chưa có pause (dữ liệu cũ chưa đồng bộ)
    ctx.session = {
      ...makeSession(),
      playerCount: 1,
      startTime: new Date('2026-08-07T11:00:00Z'),
      totalPausedSeconds: 900,
      pausedAt: null,
      pricingGroups: [{
        ...makeSession().pricingGroups[0],
        playerCount: 1,
        remainingCount: 1,
        players: [{
          id: 'player-1', name: null, pausedAt: null, totalPausedSeconds: 0,
          sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date(),
        }],
      }],
    } as unknown as SessionWithPlayers
    ctx.targetGroupId = 'group-1'
    ctx.checkoutCount = 1
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.pauseRef = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = [ctx.session.pricingGroups[0].players[0]]
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], hourlyRate: 50000, totalHours: 1, subtotal: 50000, grandTotal: 50000 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    // Elapsed 1h − pause 900s (0.25h) = 0.75h × 50k = 37.500đ
    expect(playItemCall[0].quantity).toBeCloseTo(0.75, 2)
    expect(playItemCall[0].subtotal).toBe(37500)
    expect(playItemCall[0].metadata.pausedSeconds).toBe(900)
    expect(playItemCall[0].metadata.playerPauses).toEqual([{ id: 'player-1', name: '', pausedSeconds: 900 }])
  })

  it('per-player không fallback khi nhiều người: session pause không cộng vào player (tránh double-count)', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    const players = [
      { id: 'player-1', name: null, pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
      { id: 'player-2', name: 'Minh', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      playerCount: 2,
      totalPausedSeconds: 900,
      pausedAt: null,
      pricingGroups: [{ ...makeSession().pricingGroups[0], playerCount: 2, remainingCount: 2, players }],
    } as unknown as SessionWithPlayers
    ctx.targetGroupId = 'group-1'
    ctx.checkoutCount = 2
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.pauseRef = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = players
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], hourlyRate: 50000, totalHours: 2, subtotal: 100000, grandTotal: 100000 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    // 2 người × 1h = 2h, KHÔNG trừ session pause (dữ liệu player đã có)
    expect(playItemCall[0].quantity).toBe(2)
    expect(playItemCall[0].metadata.pausedSeconds).toBe(0)
  })

  it('PLAY_TIME metadata fallback session.totalPausedSeconds khi không có player rows (legacy)', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    // Không có players (legacy) — ctx.session qua makeSession() mặc định players: []
    ctx.session = { ...makeSession(), totalPausedSeconds: 900, pausedAt: null } as unknown as SessionWithPlayers
    ctx.targetGroupId = 'group-1'
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    const state = makeState()
    state.finalPricing = { ...pricing, totalHours: 1.5 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    expect(playItemCall[0].metadata.pausedSeconds).toBe(900)
  })

  it('per-player: 2 người pause khác nhau → played time riêng, PLAY_TIME quantity = tổng played', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    // Player 1 paused 11:30→12:00 (1800s) + 300s tích lũy = 2100s paused
    // Player 2 chạy liên tục — checkout lúc 12:00, session bắt đầu 11:00 → 3600s elapsed
    const players = [
      { id: 'player-1', name: null, pausedAt: new Date('2026-08-07T11:30:00Z'), totalPausedSeconds: 300, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
      { id: 'player-2', name: 'Minh', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      pricingGroups: [{ ...makeSession().pricingGroups[0], players }],
    } as unknown as SessionWithPlayers
    ctx.targetGroupId = 'group-1'
    ctx.checkoutCount = 2
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = players
    const state = makeState()
    state.finalPricing = { ...pricing, hourlyRate: 50000, tiers: [], totalHours: 0.5, subtotal: 25000, promotionDiscount: 0, grandTotal: 25000 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    // Player 1: played = 1h (3600 − 2100 pause) → 0.5h actually (start 11:00, checkout 12:00, paused 2100s = 0.583h → 0.417h)
    // Player 2: played = 1h
    // Tổng played = 1h + 0.417h ≈ 1.42h — assert bằng tổng pause chính xác hơn
    expect(playItemCall[0].quantity).toBeCloseTo(1.42, 1)
    // Pause metadata chỉ 2 player được thu, tổng = 2100
    expect(playItemCall[0].metadata.pausedSeconds).toBe(2100)
    expect(playItemCall[0].metadata.playerPauses).toHaveLength(2)
    // Cả 2 player được đánh dấu đã thu
    expect(repos.session.markPlayersCheckedOut).toHaveBeenCalledWith(
      ['player-1', 'player-2'],
      ctx.checkoutAt
    )
  })

  it('per-player thu từng phần: 3 người thu 2 → chỉ 2 player đầu được mark', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    const players = [
      { id: 'player-1', name: null, pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
      { id: 'player-2', name: 'Minh', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
      { id: 'player-3', name: 'Lan', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:20Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      pricingGroups: [{ ...makeSession().pricingGroups[0], players }],
    } as unknown as SessionWithPlayers
    ctx.targetGroupId = 'group-1'
    ctx.checkoutCount = 2
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = players.slice(0, 2)
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], totalHours: 1, subtotal: 50000, grandTotal: 50000 }

    await runCheckOutTx(repos, ctx, state)

    // Chỉ 2 player đầu được đánh dấu
    expect(repos.session.markPlayersCheckedOut).toHaveBeenCalledWith(
      ['player-1', 'player-2'],
      ctx.checkoutAt
    )
    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    // 2 người × 1h = 2h, pause 0
    expect(playItemCall[0].quantity).toBe(2)
    expect(playItemCall[0].metadata.playerPauses).toHaveLength(2)
    expect(playItemCall[0].metadata.checkedOutPlayers).toBe(2)
  })

  // ── Thu trước: gộp logic auto-detect (thu ít hơn người đang chơi = thu trước) ──

  it('thu trước: thu 2/3 người → metadata earlyCollection.sequence=1, session còn ACTIVE', async () => {
    const repos = makeRepositories({
      billing: {
        ...makeRepositories().billing,
        countPaidBySession: vi.fn(async () => 0),
      },
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 1 })),
        sumRemainingPlayers: vi.fn(async () => 1),
      },
    })
    const ctx = makeCtx()
    const players = [
      { id: 'player-1', name: 'An', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
      { id: 'player-2', name: 'Bình', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
      { id: 'player-3', name: 'Châu', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:20Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      playerCount: 3,
      pricingGroups: [{
        ...makeSession().pricingGroups[0],
        playerCount: 3,
        remainingCount: 3,
        players,
      }],
    } as unknown as SessionWithPlayers
    // Thu 2 người đầu (player-1, player-2) — còn 1 người chưa thu → thu trước
    ctx.targetGroupId = undefined
    ctx.checkoutCount = 2
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.pauseRef = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = players.slice(0, 2)
    ctx.groupRuleMap = new Map()
    ctx.playersToBillByGroup = [['player-1', 'player-2']]
    ctx.earlyCollectionGroupIds = ['group-1']
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], totalHours: 2, subtotal: 100000, grandTotal: 100000 }

    const result = await runCheckOutTx(repos, ctx, state)

    // Chỉ 2 người được mark checked out
    expect(repos.session.markPlayersCheckedOut).toHaveBeenCalledWith(['player-1', 'player-2'], ctx.checkoutAt)
    // Decrement theo earlyCollectionGroupIds
    expect(repos.session.decrementGroupRemaining).toHaveBeenCalledWith('group-1', 2)
    // Session còn ACTIVE (remaining 1) — playerCount cập nhật còn 1, không COMPLETED
    expect(repos.session.update).toHaveBeenCalledWith('session-1', expect.objectContaining({ playerCount: 1 }))
    expect(repos.session.update).not.toHaveBeenCalledWith('session-1', expect.objectContaining({ status: 'COMPLETED' }))
    expect(result.remainingPlayers).toBe(1)
    // PLAY_TIME metadata có earlyCollection.sequence = 1 (countPaidBySession 0 + 1)
    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    expect(playItemCall[0].metadata.earlyCollection).toEqual({ sequence: 1 })
    // Notes chứa "Thu trước lần 1"
    expect(repos.billing.createPaidInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'Thu trước lần 1 — 2 người' })
    )
    // Audit có earlyCollection
    const auditCall = (repos.audit.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(auditCall.details.earlyCollection).toEqual({ sequence: 1 })
  })

  it('thu trước tăng dần: countPaidBySession 1 → lần 2', async () => {
    const repos = makeRepositories({
      billing: {
        ...makeRepositories().billing,
        countPaidBySession: vi.fn(async () => 1),
      },
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 1 })),
        sumRemainingPlayers: vi.fn(async () => 1),
      },
    })
    const ctx = makeCtx()
    const players = [
      { id: 'player-1', name: 'An', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
      { id: 'player-2', name: 'Bình', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
      { id: 'player-3', name: 'Châu', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:20Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      playerCount: 3,
      pricingGroups: [{ ...makeSession().pricingGroups[0], playerCount: 3, remainingCount: 3, players }],
    } as unknown as SessionWithPlayers
    ctx.targetGroupId = undefined
    ctx.checkoutCount = 1
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.pauseRef = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = [players[0]]
    ctx.groupRuleMap = new Map()
    ctx.playersToBillByGroup = [['player-1']]
    ctx.earlyCollectionGroupIds = ['group-1']
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], totalHours: 1, subtotal: 50000, grandTotal: 50000 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    expect(playItemCall[0].metadata.earlyCollection).toEqual({ sequence: 2 })
  })

  it('checkout cuối (thu hết người) → KHÔNG ghi nhãn earlyCollection', async () => {
    const repos = makeRepositories({
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 0 })),
        sumRemainingPlayers: vi.fn(async () => 0),
      },
    })
    const ctx = makeCtx()
    const players = [
      { id: 'player-1', name: 'An', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
      { id: 'player-2', name: 'Bình', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      playerCount: 2,
      pricingGroups: [{ ...makeSession().pricingGroups[0], playerCount: 2, remainingCount: 2, players }],
    } as unknown as SessionWithPlayers
    ctx.targetGroupId = undefined
    ctx.checkoutCount = 2
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.pauseRef = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = players
    ctx.groupRuleMap = new Map()
    ctx.playersToBillByGroup = [['player-1', 'player-2']]
    ctx.earlyCollectionGroupIds = ['group-1']
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], totalHours: 2, subtotal: 100000, grandTotal: 100000 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    // Thu hết 2/2 → không phải thu trước → metadata không có earlyCollection
    expect(playItemCall[0].metadata.earlyCollection).toBeUndefined()
    expect(repos.session.update).toHaveBeenCalledWith('session-1', expect.objectContaining({ status: 'COMPLETED' }))
  })

  it('thu trước trên session mới (chưa gán giá): preserveCounts giữ playerCount/remainingCount', async () => {
    const repos = makeRepositories({
      billing: {
        ...makeRepositories().billing,
        countPaidBySession: vi.fn(async () => 0),
      },
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 2 })),
        sumRemainingPlayers: vi.fn(async () => 2),
      },
    })
    const ctx = makeCtx()
    const players = [
      { id: 'player-1', name: 'An', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
      { id: 'player-2', name: 'Bình', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
      { id: 'player-3', name: 'Châu', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:20Z'), updatedAt: new Date() },
      { id: 'player-4', name: 'Dương', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:30Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      playerCount: 4,
      hourlyRate: 0 as never,
      pricingGroups: [{
        id: 'group-1',
        label: 'Nhóm 1',
        playerCount: 4,
        remainingCount: 4,
        hourlyRate: 0,
        pricingRuleId: null,
        pricingSnapshot: null,
        players,
      }],
    } as unknown as SessionWithPlayers
    // Thu trước 2/4 người — persist bảng giá với preserveCounts
    ctx.targetGroupId = undefined
    ctx.checkoutCount = 2
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.pauseRef = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = players.slice(0, 2)
    ctx.groupRuleMap = new Map()
    ctx.playersToBillByGroup = [['player-1', 'player-2']]
    ctx.earlyCollectionGroupIds = ['group-1']
    ctx.pendingAssignments = [{
      groupId: 'group-1',
      label: 'Nhóm 1',
      playerCount: 4,
      pricingRuleId: 'rule-1',
      snapshot: { ruleId: 'rule-1', name: 'Giờ vàng', ratePerHour: 50000, tiers: [] },
      playerIds: [],
      preserveCounts: true,
    }]
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], hourlyRate: 50000, totalHours: 2, subtotal: 100000, grandTotal: 100000 }

    await runCheckOutTx(repos, ctx, state)

    // updatePricingGroup KHÔNG kèm playerCount/remainingCount (preserveCounts)
    expect(repos.session.updatePricingGroup).toHaveBeenCalledWith('group-1', expect.not.objectContaining({
      playerCount: expect.anything(),
      remainingCount: expect.anything(),
    }))
    // Không move players (preserveCounts)
    expect(repos.session.movePlayersToGroup).not.toHaveBeenCalled()
    // Decrement theo earlyCollectionGroupIds
    expect(repos.session.decrementGroupRemaining).toHaveBeenCalledWith('group-1', 2)
    // Play time metadata có earlyCollection
    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    expect(playItemCall[0].metadata.earlyCollection).toEqual({ sequence: 1 })
  })

  it('thu trước multi-group: chọn người từ group 2 → tính theo rule của group 2 (subset index khớp)', async () => {
    const repos = makeRepositories({
      billing: {
        ...makeRepositories().billing,
        countPaidBySession: vi.fn(async () => 0),
      },
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 1 })),
        sumRemainingPlayers: vi.fn(async () => 1),
      },
    })
    const ctx = makeCtx()
    const group1Players = [
      { id: 'player-1', name: 'An', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    const group2Players = [
      { id: 'player-2', name: 'Bình', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-2', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      playerCount: 2,
      pricingGroups: [
        {
          id: 'group-1',
          label: 'Nhóm 1',
          playerCount: 1,
          remainingCount: 1,
          hourlyRate: 50000,
          pricingRuleId: 'rule-1',
          pricingSnapshot: { ruleId: 'rule-1', name: 'Giờ vàng', ratePerHour: 50000, tiers: [] },
          players: group1Players,
        },
        {
          id: 'group-2',
          label: 'Nhóm 2',
          playerCount: 1,
          remainingCount: 1,
          hourlyRate: 80000,
          pricingRuleId: 'rule-2',
          pricingSnapshot: { ruleId: 'rule-2', name: 'Giờ tối', ratePerHour: 80000, tiers: [] },
          players: group2Players,
        },
      ],
    } as unknown as SessionWithPlayers
    // Thu trước player-2 (group 2) — groupRuleMap keyed subset index 0 → group-2 rule (80k)
    ctx.targetGroupId = undefined
    ctx.checkoutCount = 1
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.pauseRef = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = group2Players
    ctx.playersToBillByGroup = [['player-2']]
    ctx.earlyCollectionGroupIds = ['group-2']
    ctx.groupRuleMap = new Map([[0, { hourlyRate: 80000, tiers: [], ruleName: 'Giờ tối' }]])
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], hourlyRate: 50000, totalHours: 1, subtotal: 50000, grandTotal: 50000 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    // player-2 tính theo group-2 rule (80k/giờ × 1h = 80k) — không phải group-1 (50k).
    // unitPrice giữ pricing.hourlyRate (50k) như hành vi hiện có; total phản ánh per-player đúng.
    expect(playItemCall[0].total).toBe(80000)
    expect(playItemCall[0].subtotal).toBe(80000)
    // playerPricing detail phản ánh rule của group-2
    expect(playItemCall[0].metadata.playerPricing[0].total).toBe(80000)
    expect(playItemCall[0].metadata.playerPricing[0].pricingRuleName).toBe('Giờ tối')
    // Decrement đúng group-2
    expect(repos.session.decrementGroupRemaining).toHaveBeenCalledWith('group-2', 1)
  })

  it('per-player legacy fallback: không có player rows → markPlayersCheckedOut không được gọi', async () => {
    const repos = makeRepositories()
    const ctx = makeCtx()
    // makeSession() mặc định players: []
    ctx.targetGroupId = 'group-1'
    ctx.checkoutCount = 1
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = []
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], totalHours: 1, subtotal: 50000, grandTotal: 50000 }

    await runCheckOutTx(repos, ctx, state)

    expect(repos.session.markPlayersCheckedOut).not.toHaveBeenCalled()
  })

  it('thu trước count-based (không chọn người): thu 1/2 → ghi nhãn earlyCollection', async () => {
    const repos = makeRepositories({
      billing: {
        ...makeRepositories().billing,
        countPaidBySession: vi.fn(async () => 0),
      },
      session: {
        ...makeRepositories().session,
        decrementGroupRemaining: vi.fn(async () => ({ remainingCount: 1 })),
        sumRemainingPlayers: vi.fn(async () => 1),
      },
    })
    const ctx = makeCtx()
    const players = [
      { id: 'player-1', name: 'An', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:00Z'), updatedAt: new Date() },
      { id: 'player-2', name: 'Bình', pausedAt: null, totalPausedSeconds: 0, sessionId: 'session-1', groupId: 'group-1', createdAt: new Date('2026-08-07T11:00:10Z'), updatedAt: new Date() },
    ] as unknown as SessionWithPlayers['pricingGroups'][number]['players']
    ctx.session = {
      ...makeSession(),
      startTime: new Date('2026-08-07T11:00:00Z'),
      playerCount: 2,
      pricingGroups: [{ ...makeSession().pricingGroups[0], playerCount: 2, remainingCount: 2, players }],
    } as unknown as SessionWithPlayers
    // Count-based: thu 1 người từ group (không playerIds) → checkoutCount 1 < 2 → thu trước
    ctx.targetGroupId = 'group-1'
    ctx.checkoutCount = 1
    ctx.checkoutAt = new Date('2026-08-07T12:00:00Z')
    ctx.endTime = new Date('2026-08-07T12:00:00Z')
    ctx.pauseRef = new Date('2026-08-07T12:00:00Z')
    ctx.playersToBill = [players[0]]
    const state = makeState()
    state.finalPricing = { ...pricing, tiers: [], totalHours: 1, subtotal: 50000, grandTotal: 50000 }

    await runCheckOutTx(repos, ctx, state)

    const playItemCall = (repos.billing.createInvoiceItem as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].type === 'PLAY_TIME'
    )
    if (!playItemCall) throw new Error('PLAY_TIME item không được tạo')
    // Thu 1/2 → auto-detect thu trước → sequence 1
    expect(playItemCall[0].metadata.earlyCollection).toEqual({ sequence: 1 })
    expect(repos.billing.createPaidInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'Thu trước lần 1 — 1 người' })
    )
    // Decrement theo targetGroupId
    expect(repos.session.decrementGroupRemaining).toHaveBeenCalledWith('group-1', 1)
  })
})
