'use client'

import { useRef, useState } from 'react'
import { Input, Label, Select } from '@/components/ui/input'
import {
  cashInputToNumber,
  formatCashInput,
  getCashInputSuggestions,
  normalizeCashInput,
} from '@/lib/shared/cash-input'
import { money, paymentMethodLabel } from './format'
import type { PaymentMethod } from './types'

const METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'CARD']

/**
 * Khối chọn phương thức thanh toán dùng chung: select + QR chuyển khoản
 * (khi chọn Chuyển khoản) + ô "Tiền khách đưa" kèm gợi ý mệnh giá và
 * số tiền trả lại / còn thiếu.
 *
 * State "tiền khách đưa" nằm trong component — khi cha đổi đối tượng thu
 * (khác phiên, khác gói hội viên) hãy gắn `key` để mount lại và tự xoá số cũ.
 */
export function PaymentMethodPicker({
  id,
  amount,
  method,
  onMethodChange,
  label,
}: {
  /** id của <select> — để Label cha (nếu có) liên kết đúng chỗ */
  id: string
  /** Số tiền cần thu, dùng tính tiền trả lại / còn thiếu */
  amount: number
  method: PaymentMethod
  onMethodChange: (method: PaymentMethod) => void
  /** Bỏ trống khi đã có nhãn bên ngoài (LedgerGroup trên POS) */
  label?: string
}) {
  const [cashReceived, setCashReceived] = useState('')
  const cashReceivedRef = useRef<HTMLInputElement>(null)

  const cashReceivedAmount = cashInputToNumber(cashReceived)
  const hasCashReceived = cashReceived.trim() !== '' && Number.isFinite(cashReceivedAmount)
  const changeAmount = cashReceivedAmount - amount

  return (
    <div>
      {label && <Label htmlFor={id}>{label}</Label>}
      <Select
        id={id}
        value={method}
        onChange={(event) => {
          const nextMethod = event.target.value as PaymentMethod
          if (nextMethod !== 'CASH') setCashReceived('')
          onMethodChange(nextMethod)
        }}
      >
        {METHODS.map((value) => (
          <option key={value} value={value}>
            {paymentMethodLabel(value)}
          </option>
        ))}
      </Select>

      {method === 'TRANSFER' && (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Quét mã QR để chuyển khoản
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/transfer2.jpeg"
            alt="Mã QR chuyển khoản"
            loading="lazy"
            className="mx-auto w-56 max-w-full"
          />
        </div>
      )}

      {method === 'CASH' && (
        <div className="mt-4 grid gap-3 border-t border-zinc-200 pt-4 sm:grid-cols-2 dark:border-zinc-800">
          <div>
            <Label htmlFor={`${id}-cash`}>Tiền khách đưa</Label>
            <Input
              id={`${id}-cash`}
              type="text"
              inputMode="numeric"
              placeholder="Ví dụ: 100"
              value={cashReceived}
              onChange={(event) => {
                const next = normalizeCashInput(
                  event.target.value,
                  event.target.selectionStart ?? event.target.value.length,
                )
                setCashReceived(next.value)
                requestAnimationFrame(() =>
                  cashReceivedRef.current?.setSelectionRange(next.caret, next.caret),
                )
              }}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {getCashInputSuggestions(cashReceived).map((suggestion) => (
                <button
                  key={suggestion.value}
                  type="button"
                  onClick={() => setCashReceived(formatCashInput(suggestion.value))}
                  className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/70">
            <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {hasCashReceived && changeAmount >= 0 ? 'Tiền trả lại' : 'Còn thiếu'}
            </span>
            <span className="mt-1 block text-lg font-bold tabular-nums text-zinc-950 dark:text-white">
              {hasCashReceived ? money(Math.abs(changeAmount)) : '—'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
