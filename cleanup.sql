-- Чистка тестовых данных перед показом салону.
-- Оставляет только: мастера "Анна Иванова" (ваш профиль), все услуги,
-- доступ персонала (staff), фото портфолио.

DELETE FROM client_notes;
DELETE FROM blocked_slots;
DELETE FROM bookings;
DELETE FROM master_services WHERE master_id IN (2, 4); -- Мария Петрова, Валера
DELETE FROM masters WHERE id IN (2, 4); -- Мария Петрова, Валера
