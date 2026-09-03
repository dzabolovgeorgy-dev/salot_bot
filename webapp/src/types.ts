export interface Master {
  id: number
  name: string
  bio: string | null
  experience_years: number | null
  photo_url: string | null
  service_ids: number[]
  schedule_anchor: string | null
  work_days: number | null
  off_days: number | null
}

export interface Service {
  id: number
  name: string
  duration_minutes: number
  price: number
  requires_allergy_check: boolean
}

export interface Booking {
  id: number
  starts_at: string
  master_id: number
  master_name: string
  service_id: number
  service_name: string
  duration_minutes: number
  price?: number
  client_name?: string | null
  status?: 'upcoming' | 'completed' | 'no_show'
  client_telegram_id?: string | number
  client_note?: string | null
  client_username?: string | null
}

export interface ClientNote {
  note: string | null
  updated_at: string | null
}

export interface BlockedSlot {
  id: number
  starts_at: string
  ends_at: string
  master_id: number
  master_name: string
  note: string | null
}

export interface ClientSummary {
  client_telegram_id: string | number
  name: string | null
  visits: number
  last_visit: string
  total_spent: number
}

export interface ClientVisit {
  id: number
  starts_at: string
  status: 'upcoming' | 'completed' | 'no_show'
  service_name: string
  price: number
  master_name: string
}

export type StaffRole =
  | { role: 'client' }
  | { role: 'master'; master_id: number; master_name: string }
  | { role: 'admin' }
