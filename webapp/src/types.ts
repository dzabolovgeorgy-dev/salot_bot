export interface Master {
  id: number
  name: string
  bio: string | null
  // Описание по-английски (сырое, для редактирования в панели); клиенту на
  // английском уже приходит переведённое в bio
  bio_en?: string | null
  experience_years: number | null
  photo_url: string | null
  service_ids: number[]
  schedule_type: 'cycle' | 'weekdays' | 'month' | null
  schedule_anchor: string | null
  work_days: number | null
  off_days: number | null
  work_weekdays: number[] | null
  schedule_month: string | null
  schedule_month_off_days: number[] | null
  work_start_time: string
  work_end_time: string
  buffer_minutes: number
  avg_rating: number | null
  ratings_count: number
}

export interface MasterPhoto {
  id: number
  url: string
  caption: string | null
  folder_ids: number[]
}

export interface PhotoFolder {
  id: number
  name: string
}

// Фото в разделе "Вдохновение" — общая подборка примеров для клиента,
// не обязательно работа конкретного мастера (master_* — null, если нет привязки)
export interface InspirationPhoto {
  id: number
  image_url: string
  category: string
  tags: string[]
  master_id: number | null
  master_name: string | null
  master_photo_url: string | null
  click_count: number
  created_at: string
}

// Фото из "Вдохновения", сохранённое клиентом (раздел "Сохранённое" в профиле)
export interface SavedPhoto {
  photo_id: number
  saved_at: string
  image_url: string
  category: string
  tags: string[]
  master_id: number | null
  master_name: string | null
  master_photo_url: string | null
}

export interface Service {
  id: number
  name: string
  // Русское название — всегда, даже на другом языке: по нему подбирается иконка
  // и категория из "Вдохновения" (name уже может быть переводом)
  name_ru: string
  // Название по-английски (сырое, для редактирования в панели)
  name_en?: string | null
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
  service_name_ru?: string
  duration_minutes: number
  price?: number
  client_name?: string | null
  status?: 'upcoming' | 'completed' | 'no_show'
  client_telegram_id?: string | number | null
  client_username?: string | null
  client_phone?: string | null
  reference_photo_id?: number | null
  reference_photo_url?: string | null
  // Только у записей из истории (GET /bookings/history) — оценка, которую
  // клиент уже поставил визиту через бота, если поставил
  rating?: number | null
  comment?: string | null
}

export interface BlockedSlot {
  id: number
  starts_at: string
  ends_at: string
  master_id: number
  master_name: string
  note: string | null
}

// Материал на складе (краска, лак и т.п.)
export interface InventoryItem {
  id: number
  name: string
  unit: string
  quantity: number
  min_threshold: number
  updated_at: string
}

// Одна запись поступления/списания материала (change_amount со знаком)
export interface InventoryTransaction {
  id: number
  change_amount: number
  reason: string | null
  created_at: string
}

// Условия отбора получателей рассылки. Пустой объект/null — все клиенты
// (но в любом случае только те, кто согласился получать рекламу)
export interface SegmentFilter {
  service_id?: number
  master_id?: number
  loyalty_tier?: string
  min_days_since_visit?: number
}

export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'completed'

// Рассылка в списке раздела "Рассылки" — вместе со статистикой отправки
export interface Broadcast {
  id: number
  text: string
  image_url: string | null
  segment_filter: SegmentFilter | null
  scheduled_at: string | null
  status: BroadcastStatus
  created_at: string
  total: number
  sent: number
  errors: number
  blocked: number
}

// Карточка одной рассылки — то же, что в списке, плюс сколько получателей
// записались в течение 7 дней после неё
export interface BroadcastDetails extends Broadcast {
  booked_within_7d: number
  first_sent_at: string | null
  conversion_window_end: string | null
}

export interface ClientSummary {
  client_telegram_id: string | number | null
  client_phone: string | null
  name: string | null
  username: string | null
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

export interface MasterReview {
  id: number
  rating: number
  comment: string
  created_at: string
}

export interface LoyaltyStatus {
  points_balance: number
  total_spent: number
  tier_name: string
  cashback_rate: number
  next_tier_name: string | null
  amount_to_next_tier: number | null
  max_redeemable: number | null
}

export interface LoyaltyHistoryEntry {
  id: number
  amount: number
  reason: string
  service_name: string | null
  created_at: string
}

export type StaffRole =
  | { role: 'client' }
  | { role: 'master'; master_id: number; master_name: string }
  | { role: 'admin' }

// То, что возвращает вход по коду в PWA-версии — то же самое, что StaffRole,
// но всегда сотрудник (клиентов по коду не бывает) и с его telegram_id,
// который в Telegram-версии браузер и так знает сам
export type PwaIdentity =
  | { role: 'master'; master_id: number; master_name: string; telegram_id: number }
  | { role: 'admin'; telegram_id: number }

// Частый вопрос для клиентского экрана FAQ (текст уже на языке клиента)
export interface FaqItem {
  id: number
  question: string
  answer: string
  show_route_button: boolean
}

export interface FaqData {
  items: FaqItem[]
  salon_address: string | null
  salon_location_url: string | null
  working_hours: string | null
}
