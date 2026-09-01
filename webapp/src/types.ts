export interface Master {
  id: number
  name: string
  bio: string | null
  experience_years: number | null
  photo_url: string | null
  service_ids: number[]
}

export interface Service {
  id: number
  name: string
  duration_minutes: number
  price: number
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
}

export interface BlockedSlot {
  id: number
  starts_at: string
  ends_at: string
  master_id: number
  master_name: string
  note: string | null
}

export type StaffRole =
  | { role: 'client' }
  | { role: 'master'; master_id: number; master_name: string }
  | { role: 'admin' }
