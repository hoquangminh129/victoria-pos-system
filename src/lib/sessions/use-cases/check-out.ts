// ── Use-case: checkOut — thu tiền, đóng phiên, trừ kho ─────
import { err, ok } from '@/lib/shared/result'
import type { DomainError, Result } from '@/lib/shared/result'
import { fail, runInTransaction } from '@/lib/infrastructure/db-helpers'
import type { Repositories } from '@/lib/infrastructure/repositories'
import { repositories } from '@/lib/infrastructure/repositories'
import type { HttpErrorInfo } from '@/lib/infrastructure/api-helpers'
import {
  toPromotionMetadata,
  type PromotionSnapshot,
} from '@/lib/promotion-calculation'
import { calculatePlayerPrice, calculateSessionPrice, calculateSessionPriceFromLoaded, type PendingGroupPricing, type PricingResult } from '../pricing-engine'
import { generateInvoiceNo } from '@/lib/invoicing'
import { getDayType, getVnDay, getVnHour } from '@/lib/shared/utils'
import { SETTING_KEYS } from '@/lib/settings'
import type { CheckoutPaymentMethod } from '@/types'
import { groupPausedSeconds, playerPausedSeconds, sessionPauseSeconds, type SessionWithPlayers } from '../ports'
import type { CheckoutLine } from './checkout-types'

export interface CheckoutLineInput {
  productId: string
  quantity: number
}

/** Nhóm bảng giá chọn tại checkout cho session chưa gán giá (khách vãng lai) */
export interface CheckoutPricingGroupInput {
  playerCount: number
  pricingRuleId: string
  /** Danh sách người chơi chọn tay vào nhóm này (đúng playerCount) */
  playerIds: string[]
}

export interface CheckoutInput {
  sessionId: string
  staffId: string
  paymentMethod: CheckoutPaymentMethod
  promotionRuleId?: string
  endTime?: Date
  items: CheckoutLineInput[]
  notes?: string
  /** ID của pricing group cần checkout (nếu không có, dùng legacy session.playerCount) */
  pricingGroupId?: string
  /** Số người checkout từ group */
  playerCount?: number
  /** Số lượng xe gửi (phí gửi xe) */
  parkingVehicleCount?: number
  /** Bảng giá áp dụng cho cả phiên — session chưa gán giá lúc check-in */
  pricingRuleId?: string
  /** Chia nhóm bảng giá tại checkout — session chưa gán giá lúc check-in */
  groups?: CheckoutPricingGroupInput[]
  /** Thu trước: chọn người chơi cụ thể (bất kỳ nhóm nào) để checkout — loại trừ với groups/pricingGroupId */
  playerIds?: string[]
}

export interface CheckoutResult {
  sessionId: string
  invoiceId: string
  invoiceNo: string
  customerName: string
  startTime: Date
  endTime: Date
  totalHours: number
  hourlyRate: number
  subtotal: number
  playSubtotal: number
  productSubtotal: number
  promotionDiscount: number
  grandTotal: number
  isMemberSession: boolean
  promotion: PromotionSnapshot | null
  paymentMethod: CheckoutPaymentMethod
  paymentId: string
  checkedOutPlayers: number
  remainingPlayers: number
  sessionClosed: boolean
  /** Tổng phí gửi xe (nếu có) */
  parkingFeeTotal?: number
}

/** Bảng giá chọn tại checkout cần gán (persist) vào SessionPricingGroup trước khi tạo invoice */
export interface PendingAssignment {
  /** Nhóm đã tồn tại (Nhóm 1 trống) — null nếu tạo nhóm mới (2..N) */
  groupId: string | null
  label: string
  playerCount: number
  pricingRuleId: string
  snapshot: import('@/types').PricingRuleSnapshot
  /** Người chơi chọn tay vào nhóm này — chuyển player sang group sau khi persist */
  playerIds: string[]
  /** Thu trước trên session mới: persist bảng giá nhưng GIỮ playerCount/remainingCount
   *  (nhóm vẫn còn người chưa thu) — không đè counts, không move players. */
  preserveCounts?: boolean
}

/** Context đã tính trước transaction — truyền vào runCheckOutTx để test được */
export interface CheckoutContext {
  session: SessionWithPlayers
  sessionId: string
  staffId: string
  paymentMethod: CheckoutPaymentMethod
  endTime: Date
  notes?: string
  checkoutCount: number
  targetGroupId?: string
  pricing: PricingResult
  checkoutLines: CheckoutLine[]
  productSubtotal: number
  /** Các dòng bán kèm chờ thu được gộp vào hoá đơn này (xoá sau khi gộp) */
  mergedSellItemIds: string[]
  /** Snapshot dòng bán kèm — để tạo InvoiceItem */
  sellItemLines: Array<{
    id: string
    productId: string
    quantity: number
    unitPrice: number
  }>
  newQuantityByProductId: Map<string, number>
  parkingVehicleCount: number
  checkoutAt: Date
  /** Null với khách vãng lai (không tạo Customer) */
  customerId: string | null
  /** Tên khách vãng lai (từ session.customerName) — null với hội viên */
  customerName: string | null
  /** Bảng giá chọn tại checkout — persist vào pricing groups trước khi tính tiền (session mới) */
  pendingAssignments?: PendingAssignment[]
  /**
   * Các player được thu lần này (chưa checkout, theo thứ tự createdAt, cắt checkoutCount).
   * Rỗng với session cũ không có player rows (legacy) → tính như cũ.
   */
  playersToBill: SessionWithPlayers['pricingGroups'][number]['players']
  /**
   * Bảng giá riêng theo từng nhóm (index nhóm → rule) khi chia nhiều bảng giá.
   * Có khi checkout tất cả nhóm trong 1 lần — mỗi player tính theo rule của nhóm chứa nó.
   */
  groupRuleMap?: Map<number, { hourlyRate: number; tiers: { minHours: number; ratePerHour: number }[]; ruleName: string }>
  /** Nhiều bảng giá: playerIds theo từng nhóm (index) — xác định nhóm của từng player + chuyển player */
  playersToBillByGroup?: string[][]
  /**
   * Thu trước trên session đã gán giá: groupId theo từng nhóm (index-aligned với
   * playersToBillByGroup) — để decrement remainingCount cho đúng nhóm sở hữu.
   */
  earlyCollectionGroupIds?: string[]
  /**
   * Mốc tính pause: min(endTime, checkoutAt) — không trừ pause sau thời điểm phiên kết thúc.
   * Đồng bộ với preview (dùng endTime làm mốc).
   */
  pauseRef: Date
}

export async function checkOut(
  input: CheckoutInput,
  deps: Repositories = repositories
): Promise<Result<CheckoutResult>> {
  const {
    sessionId,
    staffId,
    paymentMethod,
    promotionRuleId,
    endTime = new Date(),
    items,
    notes,
    pricingGroupId,
    playerCount,
    parkingVehicleCount = 0,
    pricingRuleId,
    groups,
    playerIds,
  } = input

  // ── Pha 1: Guard trước transaction ──
  // findByIdWithPlayers trả session + pricingGroups kèm players (superset của
  // findByIdForCheckout) — để tính pausedSeconds theo group chính xác.
  const session = await deps.session.findByIdWithPlayers(sessionId)
  if (!session) return err('SESSION_NOT_FOUND')
  if (session.status !== 'ACTIVE') {
    return err(session.status === 'COMPLETED' ? 'SESSION_COMPLETED' : 'SESSION_CANCELLED')
  }
  if (endTime < session.startTime) return err('END_TIME_BEFORE_START')

  // ── Session khách vãng lai check-in để trống giá → chọn bảng giá tại checkout ──
  const isMemberSession = session.customer?.type === 'MEMBER' || !!session.membership
  const needsPricingAssignment = !isMemberSession
    && session.pricingGroups.length > 0
    && session.pricingGroups.every(g => !g.pricingSnapshot && Number(g.hourlyRate) === 0)

  const checkoutAt = new Date()
  // Mốc tính pause: không trừ pause sau thời điểm phiên kết thúc (đồng bộ với preview dùng endTime)
  const pauseRef = new Date(Math.min(endTime.getTime(), checkoutAt.getTime()))

  // ── Xác định group và số người checkout ──
  let checkoutCount: number
  let targetGroupId: string | undefined
  let pendingAssignments: PendingAssignment[] | undefined
  let pendingGroups: PendingGroupPricing[] | undefined
  let groupRuleMap: CheckoutContext['groupRuleMap']
  /** Nhiều bảng giá: playerIds theo từng nhóm (index) — chuyển player sau khi persist */
  let playersToBillByGroup: string[][] | undefined
  /** Nhiều bảng giá: danh sách player thực tế được thu (theo playerIds) */
  let playersToBillInput: SessionWithPlayers['pricingGroups'][number]['players'] | undefined
  /** Thu trước: groupId theo từng nhóm sở hữu (index-aligned với playersToBillByGroup) — để decrement đúng group */
  let earlyCollectionGroupIds: string[] | undefined

  if (playerIds) {
    // ── THU TRƯỚC: chọn người chơi cụ thể ở bất kỳ nhóm nào để checkout ──
    // Mỗi player tính theo rule của nhóm sở hữu (pricingSnapshot đã persist) —
    // session cũ (chưa gán giá) dùng pricingRuleId cho nhóm duy nhất.
    const allPlayers = session.pricingGroups.flatMap((g) => g.players)
    const playerById = new Map(allPlayers.map((p) => [p.id, p]))
    const selectedIds = playerIds.filter((pid) => {
      const player = playerById.get(pid)
      return !!player && !player.checkedOutAt
    })
    if (selectedIds.length === 0) return err('NO_PLAYERS_TO_CHECKOUT')

    // Nhóm các player được chọn theo owning group (giữ thứ tự nhóm)
    const groupedByGroup = session.pricingGroups
      .map((g) => ({
        group: g,
        ids: g.players
          .filter((p) => !p.checkedOutAt && selectedIds.includes(p.id))
          .map((p) => p.id),
      }))
      .filter((entry) => entry.ids.length > 0)
    playersToBillByGroup = groupedByGroup.map((entry) => entry.ids)
    earlyCollectionGroupIds = groupedByGroup.map((entry) => entry.group.id)
    playersToBillInput = selectedIds
      .map((pid) => playerById.get(pid))
      .filter((p): p is NonNullable<typeof p> => !!p)
    checkoutCount = playersToBillInput.length
    targetGroupId = undefined

    // groupRuleMap: mỗi group sở hữu → rule snapshot. KEYED theo index trong
    // playersToBillByGroup (subset index) — phải khớp playerGroupIndex trong runCheckOutTx
    // (vì playersToBillByGroup chỉ chứa group được chọn, không phải group index gốc).
    groupRuleMap = new Map()
    groupedByGroup.forEach((entry, index) => {
      const snapshot = entry.group.pricingSnapshot as unknown as import('@/types').PricingRuleSnapshot | null
      if (snapshot) {
        groupRuleMap!.set(index, {
          hourlyRate: snapshot.ratePerHour,
          tiers: snapshot.tiers.map((t) => ({ minHours: t.minHours, ratePerHour: t.ratePerHour })),
          ruleName: snapshot.name,
        })
      }
    })

    // Session chưa gán giá (needsPricingAssignment) — resolve 1 rule cho phiên,
    // persist vào các group sở hữu với preserveCounts (giữ người chưa thu).
    if (needsPricingAssignment) {
      const resolved = await resolveCheckoutPricing(deps, session, { pricingRuleId }, checkoutAt)
      if (!resolved.ok) return resolved
      const snapshot = resolved.value.pendingGroups[0]?.snapshot
      if (!snapshot) return err('PRICING_RULE_NOT_FOUND')
      const owningGroupIds = new Set(groupedByGroup.map((entry) => entry.group.id))
      pendingAssignments = Array.from(owningGroupIds).map((gid) => ({
        groupId: gid,
        label: session.pricingGroups.find((g) => g.id === gid)?.label ?? 'Nhóm 1',
        playerCount: session.pricingGroups.find((g) => g.id === gid)?.playerCount ?? checkoutCount,
        pricingRuleId: resolved.value.pendingAssignments[0].pricingRuleId,
        snapshot,
        playerIds: [],
        preserveCounts: true,
      }))
      // Gán lại groupRuleMap theo subset index (dùng snapshot vừa resolve)
      groupRuleMap = new Map()
      groupedByGroup.forEach((entry, index) => {
        groupRuleMap!.set(index, {
          hourlyRate: snapshot.ratePerHour,
          tiers: snapshot.tiers.map((t) => ({ minHours: t.minHours, ratePerHour: t.ratePerHour })),
          ruleName: snapshot.name,
        })
      })
    }
  } else if (needsPricingAssignment) {
    const resolved = await resolveCheckoutPricing(deps, session, { pricingRuleId, groups }, checkoutAt)
    if (!resolved.ok) return resolved
    pendingAssignments = resolved.value.pendingAssignments
    pendingGroups = resolved.value.pendingGroups

    if (groups && groups.length > 0) {
      // ── Nhiều bảng giá: thu hết tất cả nhóm trong 1 lần ──
      // Mỗi player chọn tay vào nhóm (playerIds) — tính theo rule của nhóm chứa nó.
      const allPlayers = session.pricingGroups.flatMap((g) => g.players)
      const playerById = new Map(allPlayers.map((p) => [p.id, p]))
      // Chỉ giữ player tồn tại + chưa checkout — tránh thu lại người đã thu (double bill)
      const validGroups = groups.map((g) => ({
        ...g,
        playerIds: g.playerIds.filter((pid) => {
          const player = playerById.get(pid)
          return !!player && !player.checkedOutAt
        }),
      }))
      const allPlayerIds = validGroups.flatMap((g) => g.playerIds)
      checkoutCount = allPlayerIds.length
      if (checkoutCount <= 0) return err('NO_PLAYERS_TO_CHECKOUT')
      targetGroupId = undefined
      groupRuleMap = new Map()
      validGroups.forEach((g, index) => {
        const snapshot = pendingGroups?.[index]?.snapshot
        if (snapshot) {
          groupRuleMap!.set(index, {
            hourlyRate: snapshot.ratePerHour,
            tiers: snapshot.tiers.map((t) => ({ minHours: t.minHours, ratePerHour: t.ratePerHour })),
            ruleName: snapshot.name,
          })
        }
      })
      // playersToBill được xác định dưới (theo playerIds, giữ thứ tự nhóm)
      playersToBillByGroup = validGroups.map((g) => g.playerIds)
      playersToBillInput = allPlayerIds
        .map((pid) => playerById.get(pid))
        .filter((p): p is NonNullable<typeof p> => !!p)
    } else {
      // ── 1 bảng giá cho cả phiên: thu nhóm đầu tiên (Nhóm 1) ──
      const firstGroup = session.pricingGroups[0]
      targetGroupId = firstGroup.id
      const firstGroupCount = pendingGroups[0].playerCount
      checkoutCount = Math.min(
        playerCount ?? firstGroupCount,
        firstGroupCount
      )
      if (checkoutCount <= 0) return err('NO_PLAYERS_TO_CHECKOUT')
    }
  } else if (pricingGroupId) {
    const group = session.pricingGroups.find(g => g.id === pricingGroupId)
    if (!group) return err('PRICING_GROUP_NOT_FOUND')
    if (group.remainingCount <= 0) return err('PRICING_GROUP_EMPTY')
    checkoutCount = Math.min(
      playerCount ?? group.remainingCount,
      group.remainingCount
    )
    if (checkoutCount <= 0) return err('NO_PLAYERS_TO_CHECKOUT')
    targetGroupId = group.id
  } else {
    // Legacy path: dùng session.playerCount
    if (session.pricingGroups.length > 0) {
      // Session mới có groups, checkout từ group đầu tiên còn người
      const firstGroup = session.pricingGroups.find(g => g.remainingCount > 0)
      if (!firstGroup) return err('NO_PLAYERS_TO_CHECKOUT')
      checkoutCount = Math.min(
        playerCount ?? firstGroup.remainingCount,
        firstGroup.remainingCount
      )
      if (checkoutCount <= 0) return err('NO_PLAYERS_TO_CHECKOUT')
      targetGroupId = firstGroup.id
    } else {
      // Session cũ không có groups (legacy)
      checkoutCount = Math.min(
        playerCount ?? session.playerCount,
        session.playerCount
      )
      if (checkoutCount <= 0) return err('NO_PLAYERS_TO_CHECKOUT')
    }
  }

  const selectedPromotion = promotionRuleId
    ? await deps.promotions.findAvailableById(promotionRuleId, checkoutAt)
    : null

  if (promotionRuleId && !selectedPromotion) {
    return err('PROMOTION_UNAVAILABLE')
  }

  // ── Xác định players được thu lần này (per-player pricing) ──
  // Thu checkoutCount người chưa checkout của group, theo thứ tự tạo (Người 1..N).
  // Session cũ không có player rows → playersToBill rỗng → fallback tính theo group.
  const targetGroup = targetGroupId
    ? session.pricingGroups.find((g) => g.id === targetGroupId)
    : null
  // Nhiều bảng giá: player chọn tay theo playerIds (giữ thứ tự nhóm)
  const playersToBill = groupRuleMap
    ? playersToBillInput ?? []
    : targetGroup
      ? targetGroup.players.filter((p) => !p.checkedOutAt).slice(0, checkoutCount)
      : []

  // ── Tính pausedSeconds cho pricing engine (fallback, khi không có players) ──
  // Có players → tổng pause chỉ tính cho các player được thu (per-player sau này);
  // ở đây dùng tổng toàn group làm giá trị tạm cho preview đồng bộ.
  const hasPlayers = session.pricingGroups.some((g) => g.players.length > 0)
  let pausedSeconds: number
  if (playersToBill.length > 0) {
    pausedSeconds = playersToBill.reduce(
      (sum, p) => sum + playerPauseWithSessionFallback(p, session, pauseRef, checkoutCount),
      0
    )
  } else if (hasPlayers && targetGroup) {
    pausedSeconds = groupPausedSeconds(targetGroup, pauseRef)
  } else {
    pausedSeconds = session.totalPausedSeconds ?? 0
    if (session.pausedAt) {
      pausedSeconds += Math.round(Math.max(0, (checkoutAt.getTime() - new Date(session.pausedAt).getTime())) / 1000)
    }
  }

  const pricingResult = needsPricingAssignment && pendingGroups
    ? await calculateSessionPriceFromLoaded(
        deps,
        session,
        endTime,
        selectedPromotion,
        targetGroupId,
        pendingGroups,
        0,
        pausedSeconds
      )
    : await calculateSessionPrice(deps, sessionId, endTime, selectedPromotion, targetGroupId, undefined, 0, pausedSeconds)
  if (!pricingResult.ok) return pricingResult
  const pricing = pricingResult.value
  if (pricing.membershipExpired) {
    return err('MEMBERSHIP_EXPIRED_DURING_CHECKOUT')
  }
  if (pricing.isMemberSession && promotionRuleId) {
    return err('PROMOTION_NOT_APPLICABLE')
  }

  let finalPricing = pricing
  let playDiscountTotal = pricing.promotionDiscount
  let playTotal = Math.max(0, pricing.grandTotal)

  const quantityByProductId = new Map<string, number>()
  const newQuantityByProductId = new Map<string, number>()

  // ── Gom dòng bán kèm chờ thu (SessionSellItem — đã trừ kho lúc thêm vào phiên) ──
  // Checkout gộp TOÀN BỘ dòng bán kèm còn lại vào invoice INV duy nhất.
  const sellItems = await deps.session.findSellItems(sessionId)
  const mergedSellItemIds: string[] = sellItems.map((item) => item.id)
  for (const item of sellItems) {
    quantityByProductId.set(
      item.productId,
      (quantityByProductId.get(item.productId) ?? 0) + item.quantity
    )
  }

  // ── Gom sản phẩm từ request checkout hiện tại (cần trừ kho) ──
  for (const item of items) {
    quantityByProductId.set(
      item.productId,
      (quantityByProductId.get(item.productId) ?? 0) + item.quantity
    )
    newQuantityByProductId.set(
      item.productId,
      (newQuantityByProductId.get(item.productId) ?? 0) + item.quantity
    )
  }

  const productIds = Array.from(quantityByProductId.keys())
  const products = productIds.length > 0
    ? await deps.product.findManyByIds(productIds)
    : []

  if (products.length !== productIds.length) {
    return err('PRODUCT_NOT_FOUND')
  }

  // ── Dòng hàng mới gửi kèm request checkout (chỉ items hiện tại — bán kèm tạo riêng từ sellItemLines) ──
  const checkoutLines: CheckoutLine[] = products
    .filter((product) => newQuantityByProductId.has(product.id))
    .map((product) => {
      const quantity = newQuantityByProductId.get(product.id) ?? 0
      const unitPrice = product.price
      return {
        productId: product.id,
        type: product.type,
        description: product.name,
        quantity,
        unitPrice,
        subtotal: quantity * unitPrice,
      }
    })

  // ── Tổng hàng hoá = hàng mới trong request + hàng bán kèm chờ thu ──
  const sellSubtotal = sellItems.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0
  )
  const productSubtotal =
    checkoutLines.reduce((sum, line) => sum + line.subtotal, 0) + sellSubtotal

  // ── Nhân tiền giờ chơi với số người checkout ──
  const multipliedSubtotal = pricing.subtotal * checkoutCount
  const multipliedPlayTotal = playTotal * checkoutCount

  let invoiceSubtotal = multipliedSubtotal + productSubtotal
  let invoiceGrandTotal = multipliedPlayTotal + productSubtotal
  const paidAt = checkoutAt

  const ctx: CheckoutContext = {
    session,
    sessionId,
    staffId,
    paymentMethod,
    endTime,
    notes,
    checkoutCount,
    targetGroupId,
    pricing,
    checkoutLines,
    productSubtotal,
    mergedSellItemIds,
    sellItemLines: sellItems.map((item) => ({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    newQuantityByProductId,
    parkingVehicleCount,
    checkoutAt,
    customerId: session.customerId,
    customerName: session.customerName ?? null,
    pendingAssignments,
    playersToBill,
    groupRuleMap,
    playersToBillByGroup,
    pauseRef,
    earlyCollectionGroupIds,
  }

  const result = await runInTransaction((tx) =>
    runCheckOutTx(tx, ctx, {
      finalPricing,
      playDiscountTotal,
      playTotal,
      invoiceSubtotal,
      invoiceGrandTotal,
      paidAt,
      promotionRuleId,
    })
  )

  if (!result.ok) return result
  // Cập nhật mutable state từ tx (finalPricing / totals được tính lại trong tx)
  finalPricing = result.value.finalPricing
  playDiscountTotal = result.value.playDiscountTotal
  playTotal = result.value.playTotal
  invoiceSubtotal = result.value.invoiceSubtotal
  invoiceGrandTotal = result.value.invoiceGrandTotal

  const isFullCheckout = result.value.remainingPlayers <= 0

  return ok({
    sessionId,
    invoiceId: result.value.invoice.id,
    invoiceNo: result.value.invoice.invoiceNo,
    customerName: session.customerName ?? session.customer?.fullName ?? 'Khách lẻ',
    startTime: session.startTime,
    endTime,
    totalHours: finalPricing.totalHours,
    hourlyRate: finalPricing.hourlyRate,
    subtotal: invoiceSubtotal,
    playSubtotal: finalPricing.subtotal,
    productSubtotal,
    promotionDiscount: playDiscountTotal,
    grandTotal: invoiceGrandTotal,
    isMemberSession: finalPricing.isMemberSession,
    promotion: finalPricing.promotion,
    paymentMethod,
    paymentId: result.value.payment.id,
    checkedOutPlayers: checkoutCount,
    remainingPlayers: result.value.remainingPlayers,
    sessionClosed: isFullCheckout,
    parkingFeeTotal: result.value.parkingFeeTotal,
  })
}

/**
 * Resolve bảng giá tại checkout cho session chưa gán giá (pre-tx).
 * - `input.groups` (chia nhóm): resolve từng rule, kiểm tra hiệu lực, tổng người khớp session.
 * - `input.pricingRuleId` (1 bảng giá cho cả phiên): resolve rule đó, áp cho toàn bộ.
 * - Không gửi gì: auto-resolve rule hiệu lực tại giờ checkout.
 * Trả về PendingAssignment[] (để persist vào group) + PendingGroupPricing[] (để tính giá).
 */
async function resolveCheckoutPricing(
  deps: Repositories,
  session: SessionWithPlayers,
  input: { pricingRuleId?: string; groups?: CheckoutPricingGroupInput[] },
  at: Date
): Promise<Result<{ pendingAssignments: PendingAssignment[]; pendingGroups: PendingGroupPricing[] }>> {
  const snapshotOf = (rule: NonNullable<Awaited<ReturnType<Repositories['pricing']['findByIdWithTiers']>>>): PendingAssignment['snapshot'] => ({
    ruleId: rule.id,
    name: rule.name,
    ratePerHour: Number(rule.ratePerHour),
    tiers: rule.tiers.map((t) => ({ minHours: t.minHours, ratePerHour: Number(t.ratePerHour) })),
  })

  const isEffective = (rule: NonNullable<Awaited<ReturnType<Repositories['pricing']['findByIdWithTiers']>>>): boolean => {
    const currentDay = getVnDay(at)
    const dayMatches = rule.daysOfWeek.length === 0 || rule.daysOfWeek.includes(currentDay)
    const effectiveFromOk = rule.effectiveFrom <= at
    const effectiveToOk = !rule.effectiveTo || rule.effectiveTo >= at
    return dayMatches && effectiveFromOk && effectiveToOk
  }

  // Nhóm 1 trống đã tồn tại trong DB (check-in), nhóm 2..N tạo mới khi persist
  const existingGroup = session.pricingGroups[0]

  if (input.groups && input.groups.length > 0) {
    const totalPlayers = input.groups.reduce((sum, g) => sum + g.playerCount, 0)
    // Thu hết tất cả người → totalPlayers === session.playerCount (full checkout).
    // Thu trước (subset) → totalPlayers < session.playerCount — cho phép, persist với preserveCounts
    // để giữ playerCount/remainingCount của group cho người chưa thu.
    const isPartialGroups = totalPlayers < session.playerCount
    if (totalPlayers > session.playerCount) {
      return err('GROUP_PLAYER_COUNT_MISMATCH')
    }

    // Mỗi nhóm phải khớp số người chọn (subset cho phép playerIds.length <= playerCount)
    for (const g of input.groups) {
      if (!Array.isArray(g.playerIds) || g.playerIds.length > g.playerCount) {
        return err('GROUP_PLAYER_COUNT_MISMATCH')
      }
    }
    // Thu trước (subset) trên session mới chỉ hỗ trợ 1 nhóm (Nhóm 1 tồn tại) —
    // chia nhiều nhóm + subset làm lệch remainingCount giữa nhóm mới và nhóm gốc.
    if (isPartialGroups && input.groups.length > 1) {
      return err('GROUP_PLAYER_COUNT_MISMATCH')
    }

    const pendingAssignments: PendingAssignment[] = []
    const pendingGroups: PendingGroupPricing[] = []
    for (let i = 0; i < input.groups.length; i += 1) {
      const groupInput = input.groups[i]
      const rule = await deps.pricing.findByIdWithTiers(groupInput.pricingRuleId)
      if (!rule) return err('PRICING_RULE_NOT_FOUND')
      if (!isEffective(rule)) return err('PRICING_RULE_NOT_EFFECTIVE')

      const snapshot = snapshotOf(rule)
      pendingAssignments.push({
        groupId: i === 0 ? (existingGroup?.id ?? null) : null,
        label: `Nhóm ${i + 1}`,
        playerCount: groupInput.playerCount,
        pricingRuleId: rule.id,
        snapshot,
        playerIds: groupInput.playerIds,
        // Thu trước (subset): giữ playerCount/remainingCount của group cho người chưa thu
        preserveCounts: isPartialGroups,
      })
      pendingGroups.push({
        groupId: i === 0 ? existingGroup?.id : undefined,
        playerCount: groupInput.playerCount,
        snapshot,
      })
    }
    return ok({ pendingAssignments, pendingGroups })
  }

  if (input.pricingRuleId) {
    const rule = await deps.pricing.findByIdWithTiers(input.pricingRuleId)
    if (!rule) return err('PRICING_RULE_NOT_FOUND')
    if (!isEffective(rule)) return err('PRICING_RULE_NOT_EFFECTIVE')

    const snapshot = snapshotOf(rule)
    const totalPlayers = session.playerCount
    return ok({
      pendingAssignments: [{
        groupId: existingGroup?.id ?? null,
        label: 'Nhóm 1',
        playerCount: totalPlayers,
        pricingRuleId: rule.id,
        snapshot,
        playerIds: [],
      }],
      pendingGroups: [{ groupId: existingGroup?.id, playerCount: totalPlayers, snapshot }],
    })
  }

  // Auto-resolve theo giờ checkout
  const currentHour = getVnHour(at)
  const dayType = getDayType(at)
  const rule = await deps.pricing.findApplicableRule(currentHour, dayType, at)
  if (!rule) return err('PRICING_RULE_NOT_FOUND')

  const snapshot = snapshotOf(rule)
  const totalPlayers = session.playerCount
  return ok({
    pendingAssignments: [{
      groupId: existingGroup?.id ?? null,
      label: 'Nhóm 1',
      playerCount: totalPlayers,
      pricingRuleId: rule.id,
      snapshot,
      playerIds: [],
    }],
    pendingGroups: [{ groupId: existingGroup?.id, playerCount: totalPlayers, snapshot }],
  })
}

/** Mutable state tính lại bên trong transaction — truyền qua ref object */
export interface CheckoutTxState {
  finalPricing: PricingResult
  playDiscountTotal: number
  playTotal: number
  invoiceSubtotal: number
  invoiceGrandTotal: number
  paidAt: Date
  promotionRuleId?: string
}

export interface CheckoutTxResult {
  invoice: { id: string; invoiceNo: string }
  payment: { id: string }
  remainingPlayers: number
  parkingFeeTotal: number
  invoiceNo: string
  finalPricing: PricingResult
  playDiscountTotal: number
  playTotal: number
  invoiceSubtotal: number
  invoiceGrandTotal: number
}

/**
 * Thân transaction — tách riêng để unit test với fake repositories.
 * Lỗi validation trong tx dùng fail() → throw RollbackSignal → rollback.
 */
export async function runCheckOutTx(
  tx: Repositories,
  ctx: CheckoutContext,
  state: CheckoutTxState
): Promise<CheckoutTxResult> {
  const {
    session,
    sessionId,
    staffId,
    paymentMethod,
    endTime,
    notes,
    checkoutCount,
    targetGroupId,
    pricing,
    checkoutLines,
    productSubtotal,
    mergedSellItemIds,
    sellItemLines,
    newQuantityByProductId,
    parkingVehicleCount,
    checkoutAt,
    customerId,
    customerName,
    pendingAssignments,
    playersToBill,
    groupRuleMap,
    playersToBillByGroup,
    pauseRef,
    earlyCollectionGroupIds,
  } = ctx
  const { paidAt, promotionRuleId } = state
  let {
    finalPricing,
    playDiscountTotal,
    playTotal,
    invoiceSubtotal,
    invoiceGrandTotal,
  } = state

  const openShift = await tx.shift.findOpenForStaff(staffId)
  if (!openShift) fail('SHIFT_REQUIRED')

  const shiftId = openShift.id

  // ── Gán bảng giá cho pricing groups (session mới, chọn giá tại checkout) ──
  if (pendingAssignments && pendingAssignments.length > 0) {
    for (let i = 0; i < pendingAssignments.length; i += 1) {
      const assignment = pendingAssignments[i]
      let groupId = assignment.groupId
      if (assignment.groupId) {
        await tx.session.updatePricingGroup(assignment.groupId, {
          label: assignment.label,
          // preserveCounts (thu trước): giữ playerCount/remainingCount — nhóm vẫn còn người chưa thu
          ...(assignment.preserveCounts
            ? {}
            : { playerCount: assignment.playerCount, remainingCount: assignment.playerCount }),
          hourlyRate: assignment.snapshot.ratePerHour,
          pricingRuleId: assignment.pricingRuleId,
          pricingSnapshot: assignment.snapshot,
        })
      } else {
        const created = await tx.session.createPricingGroup({
          sessionId,
          label: assignment.label,
          playerCount: assignment.playerCount,
          remainingCount: assignment.playerCount,
          hourlyRate: assignment.snapshot.ratePerHour,
          pricingRuleId: assignment.pricingRuleId,
          pricingSnapshot: assignment.snapshot,
        })
        groupId = created.id
        // Ghi lại id thật để phần decrement dùng đúng group
        assignment.groupId = created.id
      }
      // Chuyển player chọn tay vào đúng nhóm (nhiều bảng giá).
      // preserveCounts (thu trước): người chọn đã thuộc nhóm sở hữu từ check-in — không move.
      const playerIds = assignment.playerIds
      if (groupId && playerIds.length > 0 && !assignment.preserveCounts) {
        await tx.session.movePlayersToGroup(playerIds, groupId)
      }
    }
  }

  // ── Re-validate membership trong transaction (TOCTOU guard) ──
  if (pricing.isMemberSession) {
    if (!customerId) fail('MEMBERSHIP_EXPIRED_DURING_CHECKOUT')
    const activeNow = await tx.membership.findActive(customerId, new Date())
    if (!activeNow) {
      fail('MEMBERSHIP_EXPIRED_DURING_CHECKOUT')
    }
  }

  const promotion = promotionRuleId
    ? await tx.promotions.findAvailableById(promotionRuleId, checkoutAt)
    : null

  if (promotionRuleId && !promotion) {
    fail('PROMOTION_UNAVAILABLE')
  }

  // ── Tính tiền giờ chơi per-player ──
  // Mỗi người chơi tính theo played time riêng (elapsed − pause), tiered + khuyến mại
  // riêng, rồi cộng tổng. Khuyến mại áp dụng cho tất cả người chơi được thu.
  // Nhiều bảng giá (groupRuleMap): mỗi player dùng rule của nhóm chứa nó (theo index).
  const totalPlayerCount = playersToBill.length
  const pausedSecondsPerPlayer = totalPlayerCount > 0
    ? playersToBill.map((p) => playerPauseWithSessionFallback(p, session, pauseRef, checkoutCount))
    : []
  // playerId → index nhóm (nhiều bảng giá, chọn tay)
  const playerGroupIndex = new Map<string, number>()
  if (playersToBillByGroup) {
    playersToBillByGroup.forEach((ids, index) => {
      for (const id of ids) playerGroupIndex.set(id, index)
    })
  }
  const playerPriceResults = totalPlayerCount > 0
    ? playersToBill.map((player, i) => {
        const groupIndex = playerGroupIndex.get(player.id)
        const groupRule = groupIndex !== undefined ? groupRuleMap?.get(groupIndex) : undefined
        return calculatePlayerPrice({
          startTime: session.startTime,
          endTime,
          pausedSeconds: pausedSecondsPerPlayer[i],
          hourlyRate: groupRule?.hourlyRate ?? pricing.hourlyRate,
          tiers: groupRule?.tiers ?? pricing.tiers,
          promotion,
        })
      })
    : []

  // Played time tổng (giờ) — dùng cho PLAY_TIME quantity
  const totalPlayedHours = totalPlayerCount > 0
    ? playerPriceResults.reduce((sum, r) => sum + r.totalHours, 0)
    : pricing.totalHours * checkoutCount

  if (totalPlayerCount > 0) {
    // ── Checkout có player rows (per-player) ──
    playDiscountTotal = playerPriceResults.reduce((sum, r) => sum + r.promotionDiscount, 0)
    playTotal = playerPriceResults.reduce((sum, r) => sum + r.grandTotal, 0)
    finalPricing = {
      ...pricing,
      totalHours: totalPlayedHours,
      subtotal: playerPriceResults.reduce((sum, r) => sum + r.subtotal, 0),
      promotionDiscount: playDiscountTotal,
      grandTotal: playTotal,
      promotion,
    }
  } else {
    // ── Legacy: session cũ không có player rows — tính 1 người rồi × checkoutCount ──
    finalPricing = {
      ...pricing,
      subtotal: pricing.subtotal * checkoutCount,
      promotionDiscount: pricing.promotionDiscount * checkoutCount,
      grandTotal: pricing.grandTotal * checkoutCount,
      promotion,
    }
    playDiscountTotal = finalPricing.promotionDiscount
    playTotal = finalPricing.grandTotal
  }
  invoiceSubtotal = finalPricing.subtotal + productSubtotal
  invoiceGrandTotal = playTotal + productSubtotal

  // ── Lấy group label ──
  const groupLabel = targetGroupId
    ? session.pricingGroups.find(g => g.id === targetGroupId)?.label ?? ''
    : ''

  // ── Bảo vệ: group có player rows nhưng thiếu người chưa checkout ──
  // (không phải legacy — có players nhưng không đủ người để thu)
  const groupHasPlayers = session.pricingGroups.some(g => g.players.length > 0)
  if (groupHasPlayers && playersToBill.length < checkoutCount) {
    fail('PLAYER_CHECKOUT_MISMATCH')
  }

  // ── Pause theo player được thu: tổng giây paused chỉ tính cho người được checkout ──
  // (fallback session-level cho phiên 1 người cũ — dữ liệu pause chưa đồng bộ xuống player)
  const playPausedSeconds = playersToBill.length > 0
    ? playersToBill.reduce((sum, p) => sum + playerPauseWithSessionFallback(p, session, pauseRef, checkoutCount), 0)
    : (session.totalPausedSeconds ?? 0)
  const playerPauses = playersToBill.map(p => ({
    id: p.id,
    name: p.name ?? '',
    pausedSeconds: playerPauseWithSessionFallback(p, session, pauseRef, checkoutCount),
  }))

  // Chi tiết từng người chơi được thu — hiển thị trên hoá đơn:
  // "Người 1: 1.4h (Bảng giá) = 324.000đ"
  const playerPricing = playersToBill.map((player, i) => {
    const result = playerPriceResults[i]
    const groupIndex = playerGroupIndex.get(player.id)
    const groupRule = groupIndex !== undefined ? groupRuleMap?.get(groupIndex) : undefined
    return {
      id: player.id,
      name: player.name ?? '',
      totalHours: result?.totalHours ?? 0,
      subtotal: result?.subtotal ?? 0,
      discountAmount: result?.promotionDiscount ?? 0,
      total: result?.grandTotal ?? 0,
      pricingRuleName: groupRule?.ruleName ?? finalPricing.ruleName,
    }
  })

  // ── Thu trước: tự động detect dựa trên số người được thu ──
  // Thu số người < số người đang chơi còn lại → thu trước (ghi nhãn "lần n").
  // Thu hết (checkoutCount >= unCheckedOutBefore) → lần thu cuối, không ghi nhãn.
  const unCheckedOutBefore = session.pricingGroups.reduce(
    (sum, g) => sum + g.players.filter((p) => !p.checkedOutAt).length,
    0
  )
  const isEarlyCollection = checkoutCount < unCheckedOutBefore
  // Cạnh void: hoá đơn thu trước bị huỷ → số thứ tự có thể tái sử dụng. Chấp nhận (nhãn hiển thị).
  const earlyCollectionSequence = isEarlyCollection
    ? (await tx.billing.countPaidBySession(sessionId)) + 1
    : undefined

  const invoice = await tx.billing.createPaidInvoice({
    invoiceNo: generateInvoiceNo(),
    sessionId,
    customerId,
    shiftId,
    staffId,
    paidAt,
    notes: notes || (
      isEarlyCollection
        ? `Thu trước lần ${earlyCollectionSequence} — ${checkoutCount} người`
        : groupRuleMap
          ? `Checkout ${checkoutCount} người (nhiều bảng giá)`
          : targetGroupId
            ? `Checkout ${checkoutCount} người (${groupLabel})`
            : (checkoutCount < session.playerCount ? `Checkout ${checkoutCount}/${session.playerCount} người` : undefined)
    ),
    subtotal: invoiceSubtotal,
    discountTotal: playDiscountTotal,
    grandTotal: invoiceGrandTotal,
    lines: [],
  })

  // PLAY_TIME item: quantity là tổng played hours của các player được thu
  const playQuantity = +(finalPricing.totalHours).toFixed(2)
  await tx.billing.createInvoiceItem({
    invoiceId: invoice.id,
    type: 'PLAY_TIME',
    description: finalPricing.isMemberSession
      ? `Giờ chơi hội viên × ${checkoutCount} người`
      : targetGroupId
        ? `Giờ chơi (${groupLabel}: ${checkoutCount} người × ${moneyPerPerson(finalPricing.hourlyRate)})`
        : `Giờ chơi khách vãng lai × ${checkoutCount} người`,
    quantity: playQuantity,
    unitPrice: finalPricing.hourlyRate,
    subtotal: finalPricing.subtotal,
    discountAmount: playDiscountTotal,
    total: playTotal,
    metadata: {
      sessionId,
      customerType: session.customer?.type ?? 'WALK_IN',
      customerName: customerName ?? session.customer?.fullName ?? null,
      membershipId: session.membershipId,
      isMemberSession: finalPricing.isMemberSession,
      promotion: toPromotionMetadata(finalPricing.promotion),
      playSubtotal: finalPricing.subtotal,
      playTotal,
      checkoutCount,
      // Tổng played hours của các player được thu — không phải của 1 người
      perPersonSubtotal: playersToBill.length > 0
        ? finalPricing.subtotal / checkoutCount
        : finalPricing.subtotal,
      perPersonHours: playersToBill.length > 0
        ? finalPricing.totalHours / checkoutCount
        : finalPricing.totalHours,
      pricingGroupId: targetGroupId ?? null,
      groupLabel: groupLabel || null,
      pausedSeconds: playPausedSeconds,
      playerPauses,
      // Chi tiết giá từng người chơi — hiển thị trên hoá đơn
      playerPricing,
      // Số người được thu lần này (per-player)
      checkedOutPlayers: playersToBill.length > 0 ? checkoutCount : undefined,
      // Thu trước: số thứ tự lần thu — hiển thị badge "(thu trước lần n)" trên hoá đơn
      earlyCollection: earlyCollectionSequence !== undefined
        ? { sequence: earlyCollectionSequence }
        : undefined,
    },
  })

  // ── Phí gửi xe (trừ vào tổng thanh toán) ──
  let parkingFeeTotal = 0
  if (parkingVehicleCount > 0) {
    const unitPrice = await tx.settings.getNumeric(SETTING_KEYS.PARKING_FEE_UNIT_PRICE, 0)
    if (unitPrice > 0) {
      parkingFeeTotal = parkingVehicleCount * unitPrice
      invoiceSubtotal -= parkingFeeTotal
      invoiceGrandTotal = Math.max(0, invoiceGrandTotal - parkingFeeTotal)

      await tx.billing.createInvoiceItem({
        invoiceId: invoice.id,
        type: 'SURCHARGE',
        description: `Phí gửi xe × ${parkingVehicleCount} xe`,
        quantity: parkingVehicleCount,
        unitPrice,
        subtotal: -parkingFeeTotal,
        discountAmount: 0,
        total: -parkingFeeTotal,
        metadata: {
          surchargeType: 'PARKING',
          vehicleCount: parkingVehicleCount,
          unitPrice,
        },
      })

      await tx.billing.updateInvoiceTotals(invoice.id, invoiceSubtotal, invoiceGrandTotal)
    }
  }

  // ── Tạo InvoiceItem cho các dòng bán kèm đã chờ thu (không trừ kho — đã trừ lúc bán kèm) ──
  for (const sellLine of sellItemLines) {
    const sellProduct = await tx.product.findByIdForSale(sellLine.productId)
    if (!sellProduct || !sellProduct.isActive) {
      fail('PRODUCT_UNAVAILABLE')
    }
    await tx.billing.createInvoiceItem({
      invoiceId: invoice.id,
      productId: sellProduct.id,
      type: sellProduct.type,
      description: sellProduct.name,
      quantity: sellLine.quantity,
      unitPrice: sellLine.unitPrice,
      subtotal: sellLine.quantity * sellLine.unitPrice,
      discountAmount: 0,
      total: sellLine.quantity * sellLine.unitPrice,
    })
  }

  for (const line of checkoutLines) {
    const latestProduct = await tx.product.findByIdForSale(line.productId)
    if (!latestProduct || !latestProduct.isActive) {
      fail('PRODUCT_UNAVAILABLE')
    }

    const invoiceItem = await tx.billing.createInvoiceItem({
      invoiceId: invoice.id,
      productId: latestProduct.id,
      type: latestProduct.type,
      description: latestProduct.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      subtotal: line.subtotal,
      discountAmount: 0,
      total: line.subtotal,
    })

    const newQuantity = newQuantityByProductId.get(line.productId) ?? 0
    if (latestProduct.type === 'PRODUCT' && newQuantity > 0) {
      const stockUpdate = await tx.product.decrementStockIfAvailable(latestProduct.id, newQuantity)
      if (stockUpdate.count === 0) {
        fail('INSUFFICIENT_STOCK', latestProduct.name)
      }

      await tx.product.recordSaleMovement({
        productId: latestProduct.id,
        invoiceItemId: invoiceItem.id,
        shiftId,
        staffId,
        quantity: newQuantity,
        reason: `Bán kèm phiên ${sessionId}`,
      })
    }
  }

  const payment = await tx.billing.createPayment({
    sessionId,
    invoiceId: invoice.id,
    shiftId,
    staffId,
    totalHours: finalPricing.totalHours,
    subtotal: invoiceSubtotal,
    discountTotal: playDiscountTotal,
    grandTotal: invoiceGrandTotal,
    paymentMethod,
    paidAt,
    notes,
  })

  // ── Cập nhật group, kiểm tra còn người không ──
  let totalRemaining = 0

  if (groupRuleMap) {
    // Nhiều bảng giá: decrement từng group theo số người đã chọn cho nhóm đó (playersToBillByGroup).
    // pendingAssignments → dùng groupId của assignment; thu trước (priced) → dùng earlyCollectionGroupIds.
    if (playersToBillByGroup) {
      const groupIds = pendingAssignments
        ? pendingAssignments.map((a) => a.groupId)
        : earlyCollectionGroupIds ?? []
      for (let i = 0; i < playersToBillByGroup.length; i += 1) {
        const groupId = groupIds[i]
        const count = playersToBillByGroup[i]?.length ?? 0
        if (groupId && count > 0) {
          const updatedGroup = await tx.session.decrementGroupRemaining(groupId, count)
          if (updatedGroup.remainingCount < 0) {
            fail('PRICING_GROUP_UNDERFLOW')
          }
        }
      }
    }
    totalRemaining = await tx.session.sumRemainingPlayers(sessionId)
  } else if (targetGroupId) {
    const updatedGroup = await tx.session.decrementGroupRemaining(targetGroupId, checkoutCount)
    if (updatedGroup.remainingCount < 0) {
      fail('PRICING_GROUP_UNDERFLOW')
    }
    totalRemaining = await tx.session.sumRemainingPlayers(sessionId)
  } else {
    // Legacy path: dùng session.playerCount
    totalRemaining = session.playerCount - checkoutCount
  }

  // ── Đánh dấu các player đã thu (checkout từng phần) ──
  if (playersToBill.length > 0) {
    await tx.session.markPlayersCheckedOut(
      playersToBill.map((p) => p.id),
      checkoutAt
    )
  }

  const isFullCheckout = totalRemaining <= 0

  if (isFullCheckout) {
    await tx.session.update(sessionId, {
      shiftId,
      endTime,
      status: 'COMPLETED',
      playerCount: 0,
      totalHours: finalPricing.totalHours,
      subtotal: finalPricing.subtotal,
      pausedAt: null,
      promotionRuleId: finalPricing.promotion?.ruleId,
      promotionName: finalPricing.promotion?.name,
      promotionDiscountType: finalPricing.promotion?.discountType,
      promotionDiscountValue: finalPricing.promotion?.discountValue,
      discountAmount: playDiscountTotal,
      totalAmount: invoiceGrandTotal,
    })
  } else if (!targetGroupId) {
    // Legacy partial checkout
    await tx.session.update(sessionId, {
      playerCount: totalRemaining,
    })
  }

  // Cập nhật customer totals — chỉ với khách đã đăng ký (hội viên);
  // khách vãng lai không có Customer nên không tích luỹ tổng chi tiêu.
  if (customerId) {
    await tx.customer.recordPlay(customerId, {
      hours: +(finalPricing.totalHours * checkoutCount).toFixed(2),
      spent: invoiceGrandTotal,
    })
  }

  // ── Xoá các dòng bán kèm đã gộp vào hoá đơn này ──
  if (mergedSellItemIds.length > 0) {
    await tx.session.removeSellItems(mergedSellItemIds)
  }

  await tx.audit.append({
    userId: staffId,
    action: 'SESSION_CHECK_OUT',
    entityType: 'Session',
    entityId: sessionId,
    details: {
      invoiceId: invoice.id,
      paymentId: payment.id,
      shiftId: shiftId ?? null,
      grandTotal: invoiceGrandTotal,
      productSubtotal,
      isMemberSession: finalPricing.isMemberSession,
      playSubtotal: finalPricing.subtotal,
      promotionDiscount: playDiscountTotal,
      promotion: toPromotionMetadata(finalPricing.promotion),
      checkoutCount,
      remainingPlayers: totalRemaining,
      isFullCheckout,
      pricingGroupId: targetGroupId ?? null,
      mergedSellItemCount: mergedSellItemIds.length > 0 ? mergedSellItemIds.length : undefined,
      parkingFeeTotal: parkingFeeTotal || undefined,
      pricingAssignedAtCheckout: (pendingAssignments?.length ?? 0) > 0,
      assignedPricingRuleIds: pendingAssignments?.map(a => a.pricingRuleId),
      earlyCollection: earlyCollectionSequence !== undefined
        ? { sequence: earlyCollectionSequence }
        : undefined,
    },
  })

  return {
    invoice,
    payment,
    remainingPlayers: totalRemaining,
    parkingFeeTotal,
    invoiceNo: invoice.invoiceNo,
    finalPricing,
    playDiscountTotal,
    playTotal,
    invoiceSubtotal,
    invoiceGrandTotal,
  }
}

function moneyPerPerson(value: number): string {
  if (value >= 1000 && value % 1000 === 0) {
    return `${(value / 1000).toLocaleString('vi-VN')}kđ`
  }
  return `${value.toLocaleString('vi-VN')}đ`
}

/**
 * Pause giây của player được thu, kèm fallback session-level cho phiên 1 người cũ
 * (pause toàn phiên trước đây ghi trên Session, không ghi lên player).
 * Chỉ fallback khi có đúng 1 player chưa checkout và player chưa có pause nào —
 * tránh double-count khi dữ liệu player đã được đồng bộ (phiên mới).
 */
function playerPauseWithSessionFallback(
  player: { pausedAt: Date | null; totalPausedSeconds: number },
  session: { pausedAt: Date | null; totalPausedSeconds: number },
  now: Date,
  billableCount: number
): number {
  const playerSeconds = playerPausedSeconds(player, now)
  if (billableCount === 1 && playerSeconds === 0) {
    return sessionPauseSeconds(session, now)
  }
  return playerSeconds
}

export function mapCheckoutError(error: DomainError): HttpErrorInfo {
  switch (error.code) {
    case 'SESSION_NOT_FOUND':
      return { code: 'SESSION_NOT_FOUND', message: 'Không tìm thấy phiên', status: 404 }
    case 'SESSION_COMPLETED':
      return { code: 'SESSION_COMPLETED', message: 'Phiên đã kết thúc rồi', status: 400 }
    case 'SESSION_CANCELLED':
      return { code: 'SESSION_CANCELLED', message: 'Phiên đã bị hủy rồi', status: 400 }
    case 'END_TIME_BEFORE_START':
      return { code: 'END_TIME_BEFORE_START', message: 'Thời gian checkout không được trước lúc check-in', status: 400 }
    case 'PRICING_GROUP_NOT_FOUND':
      return { code: 'PRICING_GROUP_NOT_FOUND', message: 'Không tìm thấy nhóm giá', status: 400 }
    case 'PRICING_GROUP_EMPTY':
      return { code: 'PRICING_GROUP_EMPTY', message: 'Nhóm giá đã checkout hết người', status: 400 }
    case 'PRICING_GROUP_UNDERFLOW':
      return { code: 'PRICING_GROUP_UNDERFLOW', message: 'Số người checkout vượt quá số người còn lại của nhóm giá', status: 400 }
    case 'PLAYER_CHECKOUT_MISMATCH':
      return { code: 'PLAYER_CHECKOUT_MISMATCH', message: 'Số người chơi cần thu vượt quá số người còn lại. Vui lòng tải lại phiên.', status: 409 }
    case 'PRODUCT_NOT_FOUND':
      return { code: 'PRODUCT_NOT_FOUND', message: 'Có sản phẩm không tồn tại hoặc đã ngừng bán', status: 400 }
    case 'PRODUCT_UNAVAILABLE':
      return { code: 'PRODUCT_UNAVAILABLE', message: 'Có sản phẩm không còn bán', status: 400 }
    case 'INSUFFICIENT_STOCK':
      return { code: 'INSUFFICIENT_STOCK', message: `${error.detail ?? 'Sản phẩm'} không đủ tồn kho`, status: 400 }
    case 'NO_PLAYERS_TO_CHECKOUT':
      return { code: 'NO_PLAYERS_TO_CHECKOUT', message: 'Không còn người chơi nào để checkout', status: 400 }
    case 'SHIFT_REQUIRED':
      return { code: 'SHIFT_REQUIRED', message: 'Cần mở hoặc tham gia ca trước khi checkout', status: 409 }
    case 'MEMBERSHIP_EXPIRED_DURING_CHECKOUT':
      return { code: 'MEMBERSHIP_EXPIRED_DURING_CHECKOUT', message: 'Gói hội viên đã hết hạn trong lúc checkout. Vui lòng thử lại.', status: 409 }
    case 'PROMOTION_UNAVAILABLE':
      return { code: 'PROMOTION_UNAVAILABLE', message: 'Khuyến mại không còn hiệu lực. Vui lòng chọn lại trước khi thu tiền.', status: 409 }
    case 'PROMOTION_NOT_APPLICABLE':
      return { code: 'PROMOTION_NOT_APPLICABLE', message: 'Khuyến mại chỉ áp dụng cho tiền giờ chơi khách vãng lai.', status: 400 }
    case 'GROUP_PLAYER_COUNT_MISMATCH':
      return { code: 'GROUP_PLAYER_COUNT_MISMATCH', message: 'Tổng số người trong các nhóm không khớp số người chơi của phiên', status: 400 }
    case 'PRICING_RULE_NOT_EFFECTIVE':
      return { code: 'PRICING_RULE_NOT_EFFECTIVE', message: 'Bảng giá đã chọn không còn hiệu lực. Vui lòng chọn bảng giá khác.', status: 400 }
    case 'PRICING_RULE_NOT_FOUND':
      return {
        code: 'PRICING_RULE_NOT_FOUND',
        message: 'Không có quy tắc bảng giá hiệu lực cho thời điểm hiện tại. Vui lòng cập nhật bảng giá trước khi thu tiền.',
        status: 400,
      }
    default:
      return { code: 'UNKNOWN', message: 'Lỗi máy chủ', status: 500 }
  }
}
