'use client'

import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Label, Select, Textarea } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { apiJson, jsonRequest } from '@/lib/api'
import { money, formatDay, toNumber } from '@/features/pos/format'
import { PaymentMethodPicker } from '@/features/pos/payment-method-picker'
import type { MembershipPlan, PaymentMethod } from '@/features/pos/types'

export type MemberStatus = 'ACTIVE' | 'EXPIRED' | 'NONE'

export interface RenewMemberInput {
  /** Khách cần gia hạn (chỉ id + name + status là bắt buộc) */
  id: string
  fullName: string
  membershipStatus: MemberStatus
  currentMembership?: { expiresAt: string } | null
}

/**
 * Modal gia hạn hội viên — dùng chung cho trang danh sách hội viên và trang
 * chi tiết hội viên. Kỳ mới tự nối tiếp nếu hội viên còn hạn, bắt đầu từ
 * ngày đóng phí nếu đã hết hạn.
 */
export function RenewMemberDialog({
  member,
  plans,
  submitting,
  setSubmitting,
  onClose,
  onDone,
}: {
  member: RenewMemberInput | null
  plans: MembershipPlan[]
  submitting: boolean
  setSubmitting: (value: boolean) => void
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const { error: notifyError } = useToast()
  const [planId, setPlanId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!member) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setPlanId(plans[0]?.id ?? '')
    setPaymentMethod('CASH')
    setNotes('')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [member, plans])

  const selectedPlan = plans.find((plan) => plan.id === planId)

  const submit = async () => {
    if (!member) return
    if (!planId) {
      notifyError('Chưa có gói hội viên')
      return
    }

    setSubmitting(true)
    try {
      const data = await apiJson('/api/memberships/renew', jsonRequest({
        customerId: member.id,
        planId,
        paymentMethod,
        notes: notes.trim() || undefined,
      }))
      if (!data.success) {
        notifyError(data.error || 'Không gia hạn được hội viên')
        return
      }
      await onDone()
    } catch {
      notifyError('Lỗi kết nối máy chủ')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={!!member}
      onClose={onClose}
      title={member ? `Gia hạn - ${member.fullName}` : 'Gia hạn hội viên'}
      description="Kỳ mới tự nối tiếp nếu hội viên còn hạn"
      footer={
        <Button variant="inverse" size="lg" fullWidth disabled={submitting} onClick={submit}>
          {submitting ? 'Đang gia hạn...' : 'Thu phí & gia hạn'}
        </Button>
      }
    >
      <div className="space-y-4">
        {member && member.membershipStatus !== 'NONE' && (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-semibold text-zinc-950 dark:text-white">
              {member.fullName}
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {member.membershipStatus === 'ACTIVE' && member.currentMembership
                ? `Kỳ mới bắt đầu sau ${formatDay(member.currentMembership.expiresAt)}`
                : 'Kỳ mới bắt đầu từ ngày đóng phí'}
            </p>
          </div>
        )}
        <div className="space-y-3">
          <div>
            <Label htmlFor="renew-plan" required>Gói hội viên</Label>
            <Select
              id="renew-plan"
              value={planId}
              onChange={(event) => setPlanId(event.target.value)}
            >
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} - {money(plan.price)}
                </option>
              ))}
            </Select>
          </div>

          <PaymentMethodPicker
            key={planId}
            id="renew-payment"
            label="Phương thức thanh toán"
            amount={toNumber(selectedPlan?.price)}
            method={paymentMethod}
            onMethodChange={setPaymentMethod}
          />

          <div>
            <Label htmlFor="renew-notes">Ghi chú</Label>
            <Textarea
              id="renew-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">Tổng thu</span>
              <span className="font-semibold text-zinc-950 dark:text-white">
                {money(selectedPlan?.price)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
