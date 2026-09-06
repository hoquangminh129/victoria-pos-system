"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiJson, jsonRequest } from "@/lib/api";
import {
  calcElapsedHMS,
  formatPausedHMS,
  money,
  pausedSecondsUntil,
  toNumber,
} from "./format";
import { formatPromotionOption } from "./promotion-option";
import { PaymentMethodPicker } from "./payment-method-picker";
import {
  CheckoutPlayerPicker,
  GROUP_LABEL,
  MONEY_RAIL,
  type PickerGroup,
  type PickerMemberStat,
} from "./checkout-player-picker";
import {
  InlineProductEditor,
} from "./invoice-detail-content";
import type { InvoiceEditorLine } from "./invoice-edit-logic";
import type { PlayTimeQuote, PromotionSnapshot } from "@/types";
import type { PaymentMethod, Product, SessionRow } from "./types";

/** Cụm chi tiết trong hoá đơn: nhãn nhỏ dạng uppercase + các dòng bên dưới */
function LedgerGroup({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className={GROUP_LABEL}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Dòng chi tiết: [checkbox?] nhãn + meta ‖ tiền trên rail chung */
function LedgerRow({
  label,
  meta,
  amount,
  checked = true,
  busy,
  onUncheck,
}: {
  label: string;
  meta?: ReactNode;
  amount: string;
  checked?: boolean;
  busy?: boolean;
  onUncheck?: () => void;
}) {
  const content = (
    <>
      {onUncheck ? (
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={onUncheck}
          tabIndex={-1}
          className="mt-1 h-4 w-4 shrink-0 accent-emerald-600"
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight text-zinc-950 dark:text-white">
          {label}
        </span>
        {meta ? (
          <span className="block text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
            {meta}
          </span>
        ) : null}
      </span>
      <span
        className={`${MONEY_RAIL} pt-0.5 text-[15px] font-medium ${
          checked
            ? "text-zinc-950 dark:text-white"
            : "text-zinc-400 line-through dark:text-zinc-600"
        }`}
      >
        {amount}
      </span>
    </>
  );

  return onUncheck ? (
    <label
      className={`flex items-start gap-3 py-2 ${
        busy ? "opacity-50" : "cursor-pointer"
      }`}
    >
      {content}
    </label>
  ) : (
    <div className="flex items-start gap-3 py-2">{content}</div>
  );
}

/** Dòng tổng hợp: nhãn ‖ tiền, tuỳ điều khiển nằm ở dòng dưới để rail thẳng hàng */
function SumRow({
  label,
  hint,
  amount,
  tone = "plain",
  control,
}: {
  label: string;
  hint?: ReactNode;
  amount: ReactNode;
  tone?: "plain" | "minus" | "muted";
  control?: ReactNode;
}) {
  return (
    <div className="py-2">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1 text-sm text-zinc-700 dark:text-zinc-200">
          {label}
          {hint ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {' '}
              · {hint}
            </span>
          ) : null}
        </span>
        <span
          className={`${MONEY_RAIL} text-sm font-semibold ${
            tone === "minus"
              ? "text-red-600 dark:text-red-300"
              : tone === "muted"
                ? "font-normal text-zinc-500 dark:text-zinc-400"
                : "text-zinc-950 dark:text-white"
          }`}
        >
          {amount}
        </span>
      </div>
      {control ? <div className="mt-2">{control}</div> : null}
    </div>
  );
}

const stepperMinus =
  "flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-200 text-zinc-600 active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100 dark:border-zinc-700 dark:text-zinc-300";
const stepperPlus =
  "flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-950 text-white active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100 dark:bg-white dark:text-zinc-950";
interface CheckoutResponse {
  grandTotal: number;
}

interface PricingRuleOption {
  id: string;
  name: string;
  ratePerHour: number;
  tiers: { minHours: number; ratePerHour: number }[];
}

export function CheckoutDrawer({
  session,
  frozenAt,
  products,
  shiftReady,
  submitting,
  setSubmitting,
  onClose,
  onDone,
}: {
  session: SessionRow | null;
  frozenAt: string | null;
  products: Product[];
  shiftReady: boolean;
  submitting: boolean;
  setSubmitting: (value: boolean) => void;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { success: notifySuccess, error: notifyError } = useToast();
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [playQuote, setPlayQuote] = useState<PlayTimeQuote | null>(null);
  const [promotions, setPromotions] = useState<PromotionSnapshot[]>([]);
  const [promotionRuleId, setPromotionRuleId] = useState("");
  const [promotionsLoading, setPromotionsLoading] = useState(false);
  const [promotionsError, setPromotionsError] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [parkingVehicleCount, setParkingVehicleCount] = useState(0);
  // Bảng giá hiệu lực — chỉ cần cho session chưa gán giá (fresh walk-in)
  const [applicablePricingRules, setApplicablePricingRules] = useState<
    PricingRuleOption[]
  >([]);
  // Luồng chọn người + bảng giá thống nhất
  const [pickerGroups, setPickerGroups] = useState<PickerGroup[]>([]);
  const nextGroupKey = useRef(0);
  // Legacy: session cũ không có player rows — giữ stepper số người như trước
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [checkoutPlayerCount, setCheckoutPlayerCount] = useState(1);
  // Dòng bán kèm đang gọi API bỏ khỏi phiên
  const [removingSellItemId, setRemovingSellItemId] = useState("");
  const [quoteReloadKey, setQuoteReloadKey] = useState(0);

  const isMember =
    session?.customer?.type === "MEMBER" || !!session?.membership;
  const sessionPlayerCount = session?.playerCount ?? 1;
  const isGroupSession = sessionPlayerCount > 1;

  // Session check-in mới (để trống giá) — cần chọn bảng giá khi thu tiền
  const needsPricing =
    !!session &&
    !isMember &&
    (session.pricingGroups?.length ?? 0) > 0 &&
    session.pricingGroups!.every(
      (g) => !g.pricingSnapshot && Number(g.hourlyRate) === 0,
    );
  // Phiên có player rows (per-player) — dùng picker; không có → legacy stepper
  const sessionHasPlayers =
    (session?.pricingGroups ?? []).some((g) => (g.players?.length ?? 0) > 0);
  // Dùng picker khi vãng lai và có player rows
  const pickerActive = !!session && !isMember && sessionHasPlayers;

  // Tất cả người chưa thu của phiên
  const allUncheckedPlayers = useMemo(
    () =>
      (session?.pricingGroups ?? []).flatMap((g) =>
        (g.players ?? []).filter((p) => !p.checkedOutAt),
      ),
    [session],
  );
  const uncheckedTotal = allUncheckedPlayers.length;
  // Tổng người đang được chọn thu (từ picker)
  const selectedCount = useMemo(
    () => new Set(pickerGroups.flatMap((g) => g.selectedIds)).size,
    [pickerGroups],
  );
  // Đang thu trước = chọn ít hơn tổng người chưa thu
  const isPartialBySelection =
    pickerActive && selectedCount > 0 && selectedCount < uncheckedTotal;

  useEffect(() => {
    if (session) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setPaymentMethod("CASH");
      setCart({});
      setPromotionRuleId("");
      setPromotions([]);
      setPromotionsError("");
      setParkingVehicleCount(0);
      setApplicablePricingRules([]);
      setPickerGroups([]);
      nextGroupKey.current = 0;
      setSelectedGroupId("");
      setCheckoutPlayerCount(1);
      setRemovingSellItemId("");

      if (!isMember && !needsPricing && sessionHasPlayers) {
        // ── Phiên đã gán giá (mode B): build nhóm cố định từ pricing groups ──
        // Mỗi nhóm còn người chưa thu = 1 nhóm; mặc định chọn tất cả (thu hết).
        const groups: PickerGroup[] = (session.pricingGroups ?? [])
          .filter((g) => g.remainingCount > 0)
          .map((g) => {
            const unchecked = (g.players ?? []).filter((p) => !p.checkedOutAt);
            const snapshot = g.pricingSnapshot;
            return {
              key: g.id,
              label: g.label,
              locked: true,
              pricingRuleId: g.pricingRuleId ?? "",
              pricingRuleName: snapshot?.name,
              remainingCount: g.remainingCount,
              checkedOutCount: g.playerCount - g.remainingCount,
              members: unchecked.map((p) => ({ id: p.id, name: p.name ?? null })),
              selectedIds: unchecked.map((p) => p.id),
            };
          });
        setPickerGroups(groups);
      } else if (!isMember && !needsPricing && !sessionHasPlayers) {
        // Legacy: chọn nhóm + stepper số người
        const groups = session.pricingGroups ?? [];
        const firstActive = groups.find((g) => g.remainingCount > 0);
        setSelectedGroupId(firstActive?.id ?? "");
        setCheckoutPlayerCount(
          firstActive?.remainingCount ?? session.playerCount ?? 1,
        );
      }
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [session, isMember, needsPricing, sessionHasPlayers]);

  // Fetch bảng giá hiệu lực khi mở drawer với session cần gán giá (fresh walk-in)
  useEffect(() => {
    if (!session || !needsPricing || !pickerActive) return;
    let cancelled = false;
    const allPlayers = (session.pricingGroups ?? [])
      .flatMap((g) => g.players ?? [])
      .filter((p) => !p.checkedOutAt);
    const allPlayerIds = allPlayers.map((p) => p.id);
    const loadRules = async () => {
      try {
        const data = await apiJson<PricingRuleOption[]>(
          "/api/pricing/applicable",
        );
        if (data.success && !cancelled) {
          const rules = data.data ?? [];
          setApplicablePricingRules(rules);
          // Mặc định 1 nhóm gồm toàn bộ người chơi chưa thu, bảng giá đầu tiên
          setPickerGroups((current) =>
            current.length > 0
              ? current
              : [
                  {
                    key: `new-${nextGroupKey.current++}`,
                    label: "Nhóm 1",
                    locked: false,
                    pricingRuleId: rules[0]?.id ?? "",
                    members: allPlayers.map((p) => ({
                      id: p.id,
                      name: p.name ?? null,
                    })),
                    selectedIds: allPlayerIds,
                  },
                ],
          );
        }
      } catch {
        /* bỏ qua — UI hiển thị trạng thái chưa có bảng giá */
      }
    };
    void loadRules();
    return () => {
      cancelled = true;
    };
  }, [session, needsPricing, pickerActive]);

  // ── Build request pricing params (dùng chung cho preview và checkout) ──
  // fresh (mode A): gửi groups; đã gán giá (mode B): full đúng 1 nhóm →
  // pricingGroupId+playerCount, subset/nhiều nhóm → playerIds; legacy → stepper.
  const buildPricingParams = useCallback(() => {
    if (!session) return null;
    if (!isMember && needsPricing && pickerActive) {
      const groups = pickerGroups
        .filter((g) => g.selectedIds.length > 0)
        .map((g) => ({
          playerCount: g.selectedIds.length,
          pricingRuleId: g.pricingRuleId,
          playerIds: g.selectedIds,
        }));
      if (groups.length === 0) return null;
      return { groups };
    }
    if (!isMember && pickerActive) {
      const singleGroup = pickerGroups.length === 1 ? pickerGroups[0] : null;
      const singleFull =
        singleGroup &&
        singleGroup.selectedIds.length === singleGroup.members.length &&
        singleGroup.members.length > 0;
      if (singleFull) {
        return {
          pricingGroupId: singleGroup.key,
          playerCount: singleGroup.selectedIds.length,
        };
      }
      const playerIds = pickerGroups.flatMap((g) => g.selectedIds);
      if (playerIds.length === 0) return null;
      return { playerIds };
    }
    if (!isMember && !sessionHasPlayers) {
      // Legacy stepper
      const groups = session.pricingGroups ?? [];
      if (selectedGroupId && groups.some((g) => g.id === selectedGroupId)) {
        return {
          pricingGroupId: selectedGroupId,
          playerCount: checkoutPlayerCount,
        };
      }
      if (isGroupSession && checkoutPlayerCount < sessionPlayerCount) {
        return { playerCount: checkoutPlayerCount };
      }
      return {};
    }
    return {};
  }, [
    session,
    isMember,
    needsPricing,
    pickerActive,
    sessionHasPlayers,
    pickerGroups,
    selectedGroupId,
    checkoutPlayerCount,
    isGroupSession,
    sessionPlayerCount,
  ]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!session) {
      setPlayQuote(null);
      setQuoteError("");
      return;
    }

    let cancelled = false;
    setPlayQuote(null);
    const loadQuote = async () => {
      setQuoteLoading(true);
      setQuoteError("");
      try {
        const params = new URLSearchParams();
        if (promotionRuleId) params.set("promotionRuleId", promotionRuleId);
        if (frozenAt) params.set("endTime", frozenAt);
        const pricingParams = buildPricingParams();
        if (pricingParams) {
          if ("groups" in pricingParams && pricingParams.groups) {
            params.set("groups", JSON.stringify(pricingParams.groups));
          } else if ("playerIds" in pricingParams && pricingParams.playerIds) {
            params.set("playerIds", JSON.stringify(pricingParams.playerIds));
          } else if (pricingParams.pricingGroupId) {
            params.set("pricingGroupId", pricingParams.pricingGroupId);
            if (pricingParams.playerCount)
              params.set("playerCount", String(pricingParams.playerCount));
          } else if (
            "playerCount" in pricingParams &&
            pricingParams.playerCount
          ) {
            params.set("playerCount", String(pricingParams.playerCount));
          }
        }
        const qs = params.toString();
        const data = await apiJson<PlayTimeQuote>(
          `/api/sessions/${session.id}/checkout-preview${qs ? `?${qs}` : ""}`,
        );
        if (!data.success || !data.data) {
          throw new Error(data.error || "Không tính được tiền giờ chơi");
        }
        if (!cancelled) setPlayQuote(data.data);
      } catch (quoteLoadError) {
        if (!cancelled)
          setQuoteError(
            (quoteLoadError as Error).message ||
              "Không tính được tiền giờ chơi",
          );
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    };

    void loadQuote();
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [
    session,
    promotionRuleId,
    frozenAt,
    buildPricingParams,
    quoteReloadKey,
  ]);

  useEffect(() => {
    if (!session || session.customer?.type === "MEMBER" || !!session.membership)
      return;

    let cancelled = false;
    const loadPromotions = async () => {
      setPromotionsLoading(true);
      setPromotionsError("");
      try {
        const data = await apiJson<PromotionSnapshot[]>(
          "/api/promotions/available",
        );
        if (!data.success) {
          throw new Error(data.error || "Không tải được khuyến mại");
        }
        if (!cancelled) setPromotions(data.data ?? []);
      } catch (promotionLoadError) {
        if (!cancelled) {
          setPromotions([]);
          setPromotionsError(
            (promotionLoadError as Error).message ||
              "Không tải được khuyến mại",
          );
        }
      } finally {
        if (!cancelled) setPromotionsLoading(false);
      }
    };

    void loadPromotions();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Preview đã trả tổng per-player (N người được thu) — không nhân count nữa
  const playSubtotal = playQuote?.subtotal ?? 0;
  const playTotal = playQuote?.grandTotal ?? 0;
  const playDiscount = playQuote?.discountAmount ?? 0;
  const pendingSellItems = useMemo(
    () => playQuote?.pendingSellItems ?? [],
    [playQuote],
  );
  // Toàn bộ dòng bán kèm chờ thu sẽ được gộp vào hoá đơn khi checkout
  const pendingSellTotal = useMemo(
    () => pendingSellItems.reduce((sum, item) => sum + item.subtotal, 0),
    [pendingSellItems],
  );
  const parkingFeeUnitPrice = playQuote?.parkingFeeUnitPrice ?? 0;
  const parkingFeeTotal = parkingVehicleCount * parkingFeeUnitPrice;

  // ── Đồng hồ tick mỗi giây khi chưa chốt thời điểm thu (frozenAt null) ──
  // Giúp tính thời gian chơi/tạm dừng theo từng người mà không gọi Date.now()
  // trực tiếp trong render.
  const [nowTick, setNowTick] = useState<number | null>(null)

  useEffect(() => {
    if (!session || frozenAt) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setNowTick(Date.now())
    const timer = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(timer)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [session, frozenAt])

  // ── Tiền + thời gian từng người chơi cho bảng ──
  const memberStats = useMemo(() => {
    const stats: Record<string, PickerMemberStat> = {};
    if (!session) return stats;
    const endMs = frozenAt ? new Date(frozenAt).getTime() : (nowTick ?? new Date(session.startTime).getTime());
    const elapsedTotal = Math.max(
      0,
      Math.floor((endMs - new Date(session.startTime).getTime()) / 1000),
    );
    const pricedById = new Map(
      (playQuote?.playerPricing ?? []).map((p) => [p.id, p]),
    );
    for (const group of session.pricingGroups ?? []) {
      for (const player of group.players ?? []) {
        if (player.checkedOutAt) continue;
        const pausedSeconds = pausedSecondsUntil(
          player.pausedAt,
          player.totalPausedSeconds ?? 0,
          endMs,
        );
        const priced = pricedById.get(player.id);
        stats[player.id] = {
          amount: priced ? priced.total : null,
          playedText: hhmm(
            priced
              ? Math.round(priced.totalHours * 3600)
              : Math.max(0, elapsedTotal - pausedSeconds),
          ),
          pausedText: hhmm(pausedSeconds),
        };
      }
    }
    return stats;
  }, [session, playQuote, frozenAt, nowTick]);

  // Thời gian đã tạm dừng hiển thị khi checkout:
  // - Phiên có player rows → pause nằm ở từng người chơi; chỉ tính các player
  //   được thu lần này (đúng lựa chọn picker), chốt theo frozenAt.
  // - Phiên legacy (không player rows) → pause session-level.
  const displayPausedSeconds = useMemo(() => {
    if (!session) return 0;
    const groupHasPlayers = (session.pricingGroups ?? []).some(
      (g) => (g.players?.length ?? 0) > 0,
    );
    const pausedAtRef = frozenAt ? new Date(frozenAt).getTime() : undefined;
    if (groupHasPlayers && playQuote?.pricingGroups) {
      const billingIds = pickerActive
        ? new Set(pickerGroups.flatMap((g) => g.selectedIds))
        : null;
      return playQuote.pricingGroups.reduce(
        (sum, g) =>
          sum +
          (g.players ?? [])
            .filter(
              (p) => !p.checkedOutAt && (!billingIds || billingIds.has(p.id)),
            )
            .reduce(
              (s, p) =>
                s +
                pausedSecondsUntil(
                  p.pausedAt,
                  p.totalPausedSeconds ?? 0,
                  pausedAtRef,
                ),
              0,
            ),
        0,
      );
    }
    return pausedSecondsUntil(
      session.pausedAt,
      session.totalPausedSeconds ?? 0,
      pausedAtRef,
    );
  }, [session, playQuote, frozenAt, pickerActive, pickerGroups]);

  const playTimeText = session
    ? calcElapsedHMS(
        session.startTime,
        frozenAt ?? undefined,
        displayPausedSeconds,
      )
    : "00:00:00";

  const cartLines = products
    .map((product) => ({
      product,
      quantity: cart[product.id] ?? 0,
      total: (cart[product.id] ?? 0) * toNumber(product.price),
    }))
    .filter((line) => line.quantity > 0);
  const cartEditorLines: InvoiceEditorLine[] = cartLines.map((line) => ({
    productId: line.product.id,
    name: line.product.name,
    type: line.product.type,
    stockQuantity: line.product.stockQuantity,
    quantity: line.quantity,
    unitPrice: toNumber(line.product.price),
  }));

  const productSubtotal = cartLines.reduce((sum, line) => sum + line.total, 0);
  const sellableTotal = pendingSellTotal + productSubtotal;
  const grandTotal = Math.max(0, playTotal + sellableTotal - parkingFeeTotal);

  const pricingBlocked = needsPricing && applicablePricingRules.length === 0;
  // Chọn ít nhất 1 người khi dùng picker
  const hasAssignedPlayers = pickerActive ? selectedCount > 0 : true;

  // Cảnh báo: fresh + nhiều nhóm + thu trước (backend chỉ cho phép 1 nhóm subset)
  const freshMultiGroupPartial =
    needsPricing &&
    pickerActive &&
    pickerGroups.filter((g) => g.selectedIds.length > 0).length > 1 &&
    selectedCount < uncheckedTotal;

  const changeCart = (product: Product, delta: number) => {
    setCart((current) => {
      const currentQuantity = current[product.id] ?? 0;
      const nextQuantity = currentQuantity + delta;
      if (nextQuantity <= 0) {
        const next = { ...current };
        delete next[product.id];
        return next;
      }
      if (product.type === "PRODUCT" && nextQuantity > product.stockQuantity)
        return current;
      return { ...current, [product.id]: nextQuantity };
    });
  };

  /** Bỏ 1 dòng bán kèm khỏi phiên (hoàn kho) rồi tính lại preview */
  const removeSellItem = async (sessionSellItemId: string) => {
    if (!session) return;
    setRemovingSellItemId(sessionSellItemId);
    try {
      const data = await apiJson(
        `/api/sessions/${session.id}/sell-items`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemIds: [sessionSellItemId] }),
        },
      );
      if (!data.success) {
        notifyError(data.error || "Không bỏ được dòng bán kèm");
        return;
      }
      setQuoteReloadKey((k) => k + 1);
    } catch {
      notifyError("Lỗi kết nối máy chủ");
    } finally {
      setRemovingSellItemId("");
    }
  };

  const handleCheckout = async () => {
    if (!session) return;
    if (!shiftReady) {
      notifyError("Cần mở ca trước khi thu tiền");
      return;
    }
    if (needsPricing && applicablePricingRules.length === 0) {
      notifyError("Chưa có bảng giá hiệu lực — không thể thu tiền giờ chơi");
      return;
    }
    if (freshMultiGroupPartial) {
      notifyError("Thu trước chỉ hỗ trợ 1 nhóm — gộp về 1 nhóm hoặc thu hết");
      return;
    }
    if (pickerActive && !hasAssignedPlayers) {
      notifyError("Chọn ít nhất 1 người chơi trước khi thu tiền");
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        paymentMethod,
        promotionRuleId: promotionRuleId || null,
        items: cartLines.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
        })),
      };
      if (frozenAt) body.endTime = frozenAt;
      const pricingParams = buildPricingParams();
      if (pricingParams) {
        if ("groups" in pricingParams && pricingParams.groups) {
          body.groups = pricingParams.groups;
        } else if ("playerIds" in pricingParams && pricingParams.playerIds) {
          body.playerIds = pricingParams.playerIds;
        } else if (pricingParams.pricingGroupId) {
          body.pricingGroupId = pricingParams.pricingGroupId;
          if (pricingParams.playerCount)
            body.playerCount = pricingParams.playerCount;
        } else if (
          "playerCount" in pricingParams &&
          pricingParams.playerCount
        ) {
          body.playerCount = pricingParams.playerCount;
        }
      }
      if (parkingVehicleCount > 0) {
        body.parkingVehicleCount = parkingVehicleCount;
      }
      const data = await apiJson<CheckoutResponse>(
        `/api/sessions/${session.id}/checkout`,
        jsonRequest(body),
      );

      if (!data.success) {
        notifyError(data.error || "Không checkout được");
        return;
      }

      notifySuccess(`Đã thu ${money(data.data?.grandTotal ?? grandTotal)}`);
      await onDone();
    } catch {
      notifyError("Lỗi kết nối máy chủ");
    } finally {
      setSubmitting(false);
    }
  };

  const getCtaLabel = () => {
    if (pickerActive) {
      if (isPartialBySelection) return `Thu trước ${selectedCount} người`;
      if (uncheckedTotal === 1) return "Thu tiền & kết thúc";
      return `Thu tiền ${selectedCount} người`;
    }
    if (!isMember && !sessionHasPlayers) {
      const group = selectedGroupId
        ? session?.pricingGroups?.find((g) => g.id === selectedGroupId)
        : undefined;
      if (
        group &&
        checkoutPlayerCount < (group.remainingCount ?? sessionPlayerCount)
      )
        return `Thu tiền ${checkoutPlayerCount} người`;
      if (group && (session?.pricingGroups?.length ?? 0) > 0)
        return `Thu tiền (${group.label ?? ""})`;
      if (isGroupSession && checkoutPlayerCount < sessionPlayerCount)
        return `Thu tiền ${checkoutPlayerCount} người`;
      return "Thu tiền & kết thúc";
    }
    return "Thu tiền & kết thúc";
  };

  return (
    <>
      <Modal
        open={!!session}
        onClose={onClose}
        variant="fullscreen"
        title={
          session
            ? `Chi tiết hoá đơn - ${session.customerName ?? session.customer?.fullName ?? "Khách lẻ"}`
            : "Chi tiết hoá đơn"
        }
        description={
          session ? (
            <>
              {isMember ? "Hội viên" : "Vãng lai"}
              {session.customerPhone && (
                <>
                  {" · "}
                  <a
                    href={`tel:${session.customerPhone}`}
                    className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
                  >
                    {session.customerPhone}
                  </a>
                </>
              )}
              {isGroupSession ? ` · ${sessionPlayerCount} người` : ""}
            </>
          ) : undefined
        }
        size="lg"
        footer={
          <div className="space-y-3">
            {/* Lý do chưa thu được */}
            {quoteLoading ? (
              <p className="flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                <Loader2 size={14} className="animate-spin" />
                Đang tính tiền giờ chơi...
              </p>
            ) : quoteError ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                {quoteError}
              </p>
            ) : pricingBlocked ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                Chưa có bảng giá hiệu lực — chưa thể thu tiền.
              </p>
            ) : !shiftReady ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                Cần mở ca trước khi thu tiền.
              </p>
            ) : freshMultiGroupPartial ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                Thu trước chỉ hỗ trợ 1 nhóm — gộp về 1 nhóm hoặc thu hết.
              </p>
            ) : pickerActive && !hasAssignedPlayers ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                Chọn ít nhất 1 người chơi trước khi thu tiền.
              </p>
            ) : null}
            <div className="overflow-hidden rounded-xl border-2 border-zinc-950 dark:border-white">
              <div className="flex items-end justify-between gap-3 bg-zinc-100 px-4 py-3 dark:bg-zinc-800">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
                  Tổng cộng
                </span>
                <span className="text-[26px] font-extrabold leading-none tabular-nums text-zinc-950 dark:text-white">
                  {quoteError ? "—" : money(grandTotal)}
                </span>
              </div>
              <Button
                variant="inverse"
                size="lg"
                fullWidth
                loading={submitting}
                disabled={
                  !shiftReady ||
                  quoteLoading ||
                  !!quoteError ||
                  !playQuote ||
                  pricingBlocked ||
                  freshMultiGroupPartial ||
                  (pickerActive && !hasAssignedPlayers)
                }
                onClick={handleCheckout}
              >
                {getCtaLabel()}
              </Button>
            </div>
          </div>
        }
      >
        {session && (
          <div className="space-y-6">
            {/* ══ CHI TIẾT — giờ chơi theo từng người chơi ══ */}
            {pickerActive ? (
              pricingBlocked ? (
                <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                  Chưa có bảng giá hiệu lực — không thể thu tiền giờ chơi.
                </p>
              ) : (
                <>
                  <CheckoutPlayerPicker
                    groups={pickerGroups}
                    rules={applicablePricingRules}
                    memberStats={memberStats}
                    onChange={setPickerGroups}
                  />
                  {needsPricing &&
                    selectedCount > 0 &&
                    selectedCount < sessionPlayerCount && (
                      <p className="text-xs text-amber-600 dark:text-amber-300">
                        Thu trước{" "}
                        <span className="font-semibold tabular-nums text-zinc-950 dark:text-white">
                          {selectedCount}
                        </span>
                        /{sessionPlayerCount} người — người chưa chọn tiếp tục
                        chơi.
                      </p>
                    )}
                  {!needsPricing && isPartialBySelection && (
                    <p className="text-xs text-amber-600 dark:text-amber-300">
                      Thu trước{" "}
                      <span className="font-semibold tabular-nums text-zinc-950 dark:text-white">
                        {selectedCount}
                      </span>
                      /{uncheckedTotal} người — người chưa thu tiếp tục chơi.
                    </p>
                  )}
                </>
              )
            ) : (
              <LedgerGroup title="Giờ chơi">
                <div className="border-t border-zinc-200 dark:border-zinc-800">
                  <LedgerRow
                    label={isMember ? "Giờ chơi hội viên" : "Giờ chơi"}
                    meta={`chơi ${playTimeText} · nghỉ ${formatPausedHMS(
                      displayPausedSeconds,
                    )}`}
                    amount={
                      quoteLoading
                        ? "—"
                        : isMember
                          ? "Miễn phí"
                          : money(playSubtotal)
                    }
                  />
                </div>
              </LedgerGroup>
            )}

            {/* Legacy: session cũ không có player rows — chọn nhóm bằng danh sách dòng */}
            {!isMember &&
              !sessionHasPlayers &&
              (session.pricingGroups?.length ?? 0) > 0 && (
                <LedgerGroup title="Nhóm thu tiền">
                  <ul className="divide-y divide-zinc-100 border-t border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                    {session
                      .pricingGroups!.filter((g) => g.remainingCount > 0)
                      .map((g) => {
                        const isSelected = selectedGroupId === g.id;
                        return (
                          <li key={g.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedGroupId(g.id);
                                setCheckoutPlayerCount(g.remainingCount);
                              }}
                              className="flex w-full items-start gap-3 py-2 text-left"
                            >
                              <input
                                type="radio"
                                readOnly
                                checked={isSelected}
                                tabIndex={-1}
                                aria-label={`Chọn ${g.label}`}
                                className="mt-1 h-4 w-4 shrink-0 accent-emerald-600"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[15px] leading-tight text-zinc-950 dark:text-white">
                                  {g.label}
                                </span>
                                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                                  {g.pricingSnapshot?.name ?? "Bảng giá"} ·{" "}
                                  {money(g.hourlyRate)}/giờ · còn{" "}
                                  {g.remainingCount}/{g.playerCount}
                                </span>
                              </span>
                              <span
                                className={`${MONEY_RAIL} pt-0.5 text-[15px] font-medium text-zinc-950 dark:text-white`}
                              >
                                {g.remainingCount} người
                              </span>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                  {selectedGroupId && (
                    <LegacyStepper
                      checkoutPlayerCount={checkoutPlayerCount}
                      maxCount={
                        session.pricingGroups!.find(
                          (g) => g.id === selectedGroupId,
                        )?.remainingCount ?? sessionPlayerCount
                      }
                      unitLabel="người trong nhóm"
                      onDecrease={() =>
                        setCheckoutPlayerCount((c) => Math.max(1, c - 1))
                      }
                      onIncrease={() =>
                        setCheckoutPlayerCount((c) =>
                          Math.min(
                            session.pricingGroups!.find(
                              (g) => g.id === selectedGroupId,
                            )?.remainingCount ?? sessionPlayerCount,
                            c + 1,
                          ),
                        )
                      }
                      warning={
                        checkoutPlayerCount <
                        (session.pricingGroups!.find(
                          (g) => g.id === selectedGroupId,
                        )?.remainingCount ?? sessionPlayerCount)
                          ? `Thu ${checkoutPlayerCount} người — nhóm còn người, thu tiếp sau.`
                          : undefined
                      }
                    />
                  )}
                </LedgerGroup>
              )}

            {!isMember &&
              !sessionHasPlayers &&
              (session.pricingGroups?.length ?? 0) === 0 &&
              isGroupSession && (
                <LedgerGroup title="Nhóm thu tiền">
                  <LegacyStepper
                    checkoutPlayerCount={checkoutPlayerCount}
                    maxCount={sessionPlayerCount}
                    unitLabel="người trong phiên"
                    onDecrease={() =>
                      setCheckoutPlayerCount((c) => Math.max(1, c - 1))
                    }
                    onIncrease={() =>
                      setCheckoutPlayerCount((c) =>
                        Math.min(sessionPlayerCount, c + 1),
                      )
                    }
                    warning={
                      checkoutPlayerCount < sessionPlayerCount
                        ? `Thu ${checkoutPlayerCount} người — phiên còn ${sessionPlayerCount - checkoutPlayerCount} người, thu tiếp sau.`
                        : undefined
                    }
                  />
                </LedgerGroup>
              )}

            {/* ══ CHI TIẾT — hàng hoá / dịch vụ ══ */}
            <LedgerGroup title="Chi tiết dịch vụ">
              {pendingSellItems.length > 0 ? (
                <ul className="divide-y divide-zinc-100 border-t border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                  {pendingSellItems.map((item) => (
                    <li key={item.sessionSellItemId}>
                      <LedgerRow
                        label={item.productName}
                        meta={`Số lượng ${item.quantity} · đã thêm vào phiên`}
                        amount={money(item.subtotal)}
                        busy={removingSellItemId === item.sessionSellItemId}
                        onUncheck={() =>
                          void removeSellItem(item.sessionSellItemId)
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              {pendingSellItems.length > 0 ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Bỏ chọn món đã thêm vào phiên sẽ xoá dòng khỏi phiên và hoàn
                  kho.
                </p>
              ) : null}

              <InlineProductEditor
                lines={cartEditorLines}
                products={products.filter(
                  (product) => product.type === "SERVICE" || product.stockQuantity > 0,
                )}
                loading={false}
                onAdd={(product) => changeCart(product, 1)}
                onDecrease={(productId) => {
                  const product = products.find((item) => item.id === productId);
                  if (product) changeCart(product, -1);
                }}
                onIncrease={(productId) => {
                  const product = products.find((item) => item.id === productId);
                  if (product) changeCart(product, 1);
                }}
                onRemove={(productId) =>
                  setCart((current) => {
                    const next = { ...current };
                    delete next[productId];
                    return next;
                  })
                }
              />
            </LedgerGroup>

            {/* ══ TỔNG HỢP — các khoản ngoài dòng giờ chơi đã hiển thị ở trên ══ */}
            <section>
              <h3 className={GROUP_LABEL}>Tổng tiền</h3>
              <div className="mt-2 divide-y divide-zinc-100 border-t border-zinc-300 dark:divide-zinc-800 dark:border-zinc-700">
                <SumRow
                  label="Hàng hoá / dịch vụ"
                  hint={
                    pendingSellItems.length + cartLines.length > 0
                      ? `${pendingSellItems.length + cartLines.length} món`
                      : undefined
                  }
                  amount={money(sellableTotal)}
                  tone={sellableTotal > 0 ? "plain" : "muted"}
                />
                {!isMember && (
                  <SumRow
                    label="Khuyến mại giờ chơi"
                    hint={
                      promotionRuleId
                        ? promotions.find((p) => p.ruleId === promotionRuleId)
                            ?.name
                        : undefined
                    }
                    amount={playDiscount > 0 ? `-${money(playDiscount)}` : "—"}
                    tone={playDiscount > 0 ? "minus" : "muted"}
                    control={
                      <>
                        <Select
                          id="checkout-promotion"
                          value={promotionRuleId}
                          disabled={promotionsLoading}
                          onChange={(event) =>
                            setPromotionRuleId(event.target.value)
                          }
                        >
                          <option value="">Không áp dụng khuyến mại</option>
                          {promotions.map((promotion) => (
                            <option
                              key={promotion.ruleId}
                              value={promotion.ruleId}
                            >
                              {formatPromotionOption(promotion)}
                            </option>
                          ))}
                        </Select>
                        {promotionsError ? (
                          <p className="text-xs text-red-600 dark:text-red-300">
                            {promotionsError}
                          </p>
                        ) : null}
                      </>
                    }
                  />
                )}
                {!isMember && parkingFeeUnitPrice > 0 && (
                  <SumRow
                    label="Phí gửi xe"
                    hint={`${money(parkingFeeUnitPrice)}/xe`}
                    amount={
                      parkingFeeTotal > 0 ? `-${money(parkingFeeTotal)}` : "—"
                    }
                    tone={parkingFeeTotal > 0 ? "minus" : "muted"}
                    control={
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setParkingVehicleCount((c) => Math.max(0, c - 1))
                          }
                          disabled={parkingVehicleCount === 0}
                          aria-label="Giảm số xe"
                          className={stepperMinus}
                        >
                          <Minus size={14} />
                        </button>
                        <span className="w-8 text-center text-[15px] font-bold tabular-nums text-zinc-950 dark:text-white">
                          {parkingVehicleCount}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setParkingVehicleCount((c) => Math.min(20, c + 1))
                          }
                          aria-label="Tăng số xe"
                          className={stepperPlus}
                        >
                          <Plus size={14} />
                        </button>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          xe
                        </span>
                      </div>
                    }
                  />
                )}
              </div>
            </section>

            {/* ══ PHƯƠNG THỨC THANH TOÁN ══ */}
            <LedgerGroup title="Phương thức thanh toán">
              <PaymentMethodPicker
                key={session?.id ?? "retail"}
                id="payment-method"
                amount={grandTotal}
                method={paymentMethod}
                onMethodChange={setPaymentMethod}
              />
            </LedgerGroup>
          </div>
        )}
      </Modal>

    </>
  );
}

/** Tổng giây → hh:mm (dùng cho cột thời gian trong bảng người chơi) */
function hhmm(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [h, m].map((v) => v.toString().padStart(2, "0")).join(":");
}

/** Stepper số người thu — dùng cho session cũ không có player rows (legacy) */
function LegacyStepper({
  checkoutPlayerCount,
  maxCount,
  unitLabel,
  onDecrease,
  onIncrease,
  warning,
}: {
  checkoutPlayerCount: number;
  maxCount: number;
  unitLabel: string;
  onDecrease: () => void;
  onIncrease: () => void;
  warning?: string;
}) {
  return (
    <>
      <div className="border-t border-zinc-200 dark:border-zinc-800" />
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Số người thu
        </p>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {checkoutPlayerCount} người
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onDecrease}
          disabled={checkoutPlayerCount <= 1}
          className={stepperMinus}
        >
          <Minus size={14} />
        </button>
        <span className="text-lg font-bold tabular-nums text-zinc-950 dark:text-white">
          {checkoutPlayerCount}
        </span>
        <button
          type="button"
          onClick={onIncrease}
          disabled={checkoutPlayerCount >= maxCount}
          className={stepperPlus}
        >
          <Plus size={14} />
        </button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          / {maxCount} {unitLabel}
        </span>
      </div>
      {warning && (
        <p className="text-xs text-amber-600 dark:text-amber-300">{warning}</p>
      )}
    </>
  );
}
