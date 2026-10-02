-- =====================================================================
-- Prueba dummy · Concierge del Socio
-- Esquema mínimo en Supabase para validar el consumo desde un agente
-- de HubSpot vía MCP.
--
-- IMPORTANTE: datos ficticios. Ningún socio real vive en este esquema.
-- La llave es el TOKEN, nunca el ClubMemberCode de Jonas. Así se valida
-- desde el primer día el modelo seudonimizado que acordamos con Avándaro.
-- =====================================================================

create schema if not exists demo;

-- ---------------------------------------------------------------------
-- Socios. Lo que en producción llegaría seudonimizado desde el extractor.
-- ---------------------------------------------------------------------
create table if not exists demo.socios (
  token_socio       text primary key,
  club              text not null check (club in ('CGA', 'RACC')),
  tipo_membresia    text not null,
  categoria_acceso  text,
  antiguedad_anios  int,
  saldo             numeric(12,2) not null default 0,
  moneda            text not null default 'MXN',
  -- La fecha de corte es obligatoria en el contrato de datos: el saldo
  -- siempre trae rezago hasta el corte de caja de las 10:00.
  fecha_corte       timestamptz not null,
  ultima_visita     date
);

-- ---------------------------------------------------------------------
-- Catálogo de servicios. Esto sí es contenido compartido y es lo único
-- que tendría sentido indexar como base de conocimiento.
-- ---------------------------------------------------------------------
create table if not exists demo.servicios (
  id                bigint generated always as identity primary key,
  area              text not null,
  descripcion       text not null,
  horario_semana    text,
  horario_fin       text,
  requiere_reserva  boolean not null default false,
  responsable       text,
  extension         text,
  notas             text
);

-- ---------------------------------------------------------------------
-- Bitácora de consultas. Sirve para comprobar que el agente realmente
-- llamó a la herramienta y con qué token, que es parte de lo que
-- queremos medir en la prueba.
-- ---------------------------------------------------------------------
create table if not exists demo.consultas_log (
  id           bigint generated always as identity primary key,
  momento      timestamptz not null default now(),
  herramienta  text not null,
  token_socio  text,
  argumento    text,
  encontrado   boolean
);

-- ---------------------------------------------------------------------
-- Seguridad. El servidor MCP usa la service role, así que RLS queda
-- activo y sin políticas públicas: nadie llega a estas tablas con la
-- llave anónima.
-- ---------------------------------------------------------------------
alter table demo.socios        enable row level security;
alter table demo.servicios     enable row level security;
alter table demo.consultas_log enable row level security;

-- ---------------------------------------------------------------------
-- Datos ficticios
-- ---------------------------------------------------------------------
insert into demo.socios
  (token_socio, club, tipo_membresia, categoria_acceso, antiguedad_anios,
   saldo, fecha_corte, ultima_visita)
values
  ('TK-7F2A91', 'CGA',  'Familiar',    'Platinum', 12,  4820.50,
   (current_date + time '10:00') at time zone 'America/Mexico_City', current_date - 3),
  ('TK-3C88D4', 'CGA',  'Individual',  'Clasica',   2, -1240.00,
   (current_date + time '10:00') at time zone 'America/Mexico_City', current_date - 21),
  ('TK-B51E07', 'RACC', 'Corporativa', 'Platinum',  7, 15730.80,
   (current_date + time '10:00') at time zone 'America/Mexico_City', current_date - 1)
on conflict (token_socio) do nothing;

insert into demo.servicios
  (area, descripcion, horario_semana, horario_fin, requiere_reserva, responsable, extension, notas)
values
  ('Alberca semiolímpica', 'Alberca semiolímpica climatizada, techada',
   '7:00 a 19:00', '7:00 a 19:00', false, 'Mario Candia', '2128',
   'Menores de 12 años acompañados de un adulto'),
  ('Servicio médico', 'Consultorio de la Cruz Roja dentro del club',
   '9:00 a 19:00', '9:00 a 19:00', false, 'Variable', '2128', null),
  ('Kids Club', 'Day camp para niños de 4 a 12 años',
   'Cerrado', '9:00 a 15:00', true, 'Luhana Mejía', '308',
   'En temporada vacacional hay day camp entre semana'),
  ('Clase de yoga', 'Clase de yoga en cortesía',
   'Cerrado', '10:00', true, 'Zaraid Villagrán', '226', null),
  ('Fogatas', 'Fogata nocturna en el área designada del jardín',
   'Bajo reserva', 'Bajo reserva', true, 'Concierge', '2128',
   'Duración aproximada de hora y media. Llevar ropa abrigadora'),
  ('Cine al aire libre', 'Función de cine en el jardín, con proyector y cojines',
   'Bajo reserva', 'Bajo reserva', true, 'Concierge', '2128',
   'Duración aproximada de dos horas'),
  ('Campo de golf', 'Campo de 18 hoyos. Las salidas se reservan por tee time',
   '7:00 a 18:00', '6:30 a 18:00', true, 'Casa club', '201',
   'Anticipación máxima de reserva según categoría de membresía'),
  ('Música en vivo', 'Música en vivo en el restaurante los sábados',
   'Cerrado', '19:30', false, 'Yamil Malja', '2128', null)
on conflict do nothing;
