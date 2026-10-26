-- =====================================================================
-- Cotizador Inteligente · prueba con tarifario ficticio
-- Grupo Avándaro × Freelan
--
-- *** TODAS LAS TARIFAS DE ESTE ARCHIVO SON INVENTADAS ***
--
-- Sirven para probar la arquitectura, no para cotizar. El tarifario real
-- vive hoy en un Google Sheet que el equipo comercial usa a mano, y que
-- todavía no hemos visto. Alejandro lo confirmó en el mapeo: "Un
-- tarifario como tal vive en google sheets que usan para cotizar".
--
-- Lo que esta prueba SÍ demuestra: que HubSpot puede pedir una
-- cotización a lógica y datos que viven fuera, y recibir el desglose de
-- vuelta en el negocio. Eso es lo que está en duda, no la aritmética.
--
-- Lo que NO demuestra: disponibilidad real, que vive en Opera y sigue
-- bloqueada por OHIP; ni tarifas reales.
--
-- Los espacios y los nombres se eligieron para que Avándaro los
-- reconozca: salen de tblPOSAreas (Jardin CGA, Kiosko CGA, Torneos y
-- Eventos) y del repositorio de servicios (Centro Avándaro y Salón
-- jardín). Las cifras no.
-- =====================================================================

create schema if not exists cot;

-- ---------------------------------------------------------------------
-- Parámetros. Las tasas de impuesto van como dato y NO están
-- confirmadas: hay que validarlas con el área fiscal de Avándaro antes
-- de que esto cotice algo de verdad. El ISH en particular varía por
-- estado y por año.
-- ---------------------------------------------------------------------
create table if not exists cot.parametros (
  clave        text primary key,
  valor        numeric(12,4) not null,
  descripcion  text not null,
  confirmado   boolean not null default false
);

insert into cot.parametros (clave, valor, descripcion, confirmado) values
  ('iva',               0.1600, 'IVA sobre todos los conceptos',                    false),
  ('ish',               0.0300, 'Impuesto sobre hospedaje, solo sobre habitaciones', false),
  ('servicio',          0.1500, 'Cargo por servicio sobre alimentos y bebidas',      false),
  ('vigencia_dias',    15.0000, 'Días que la cotización se mantiene vigente',        false),
  ('anticipo_pct',      0.5000, 'Anticipo para confirmar el evento',                 false)
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------
-- Temporadas. En Valle de Bravo la alta es la seca y la de mariposa
-- monarca; la baja coincide con lluvias. Los rangos son una propuesta,
-- no un dato de Avándaro.
-- ---------------------------------------------------------------------
create table if not exists cot.temporadas (
  id          bigint generated always as identity primary key,
  nombre      text not null check (nombre in ('alta','media','baja')),
  desde_mes   int not null check (desde_mes between 1 and 12),
  desde_dia   int not null check (desde_dia between 1 and 31),
  hasta_mes   int not null check (hasta_mes between 1 and 12),
  hasta_dia   int not null check (hasta_dia between 1 and 31),
  nota        text
);

insert into cot.temporadas (nombre, desde_mes, desde_dia, hasta_mes, hasta_dia, nota) values
  ('alta',  12,  1, 12, 31, 'Diciembre y fiestas'),
  ('alta',   1,  1,  4, 30, 'Seca y mariposa monarca'),
  ('media', 10,  1, 11, 30, 'Otoño'),
  ('media',  5,  1,  5, 31, 'Previo a lluvias'),
  ('baja',   6,  1,  9, 30, 'Temporada de lluvias')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Espacios. Las capacidades son la razón por la que el Cotizador sirve:
-- el agente no debe ofrecer un salón donde la gente no cabe.
-- ---------------------------------------------------------------------
create table if not exists cot.espacios (
  clave            text primary key,
  nombre           text not null,
  tipo             text not null,
  ubicacion        text,
  interior         boolean not null default true,
  cap_auditorio    int,
  cap_banquete     int,
  cap_coctel       int,
  cap_escuela      int,
  notas            text,
  activo           boolean not null default true
);

insert into cot.espacios
  (clave, nombre, tipo, ubicacion, interior, cap_auditorio, cap_banquete, cap_coctel, cap_escuela, notas)
values
  ('SALON-CENTRO','Centro Avándaro','Salón','Casa Club, planta baja', true,
   300, 200, 400, 180, 'Divisible en tres secciones. Equipo audiovisual incluido.'),
  ('SALON-JARDIN','Salón Jardín','Salón','Contiguo al jardín principal', true,
   150, 120, 200,  90, 'Acceso directo al jardín, útil para coffee breaks al aire libre.'),
  ('JARDIN-LAGO','Jardín del Lago','Jardín','Frente al lago', false,
   null, 180, 250, null, 'Exterior. Requiere plan B techado en temporada de lluvias.'),
  ('TERRAZA-GOLF','Terraza Campo de Golf','Terraza','Hoyo 18', false,
   null, 100, 150, null, 'Exterior. Atardecer sobre el campo.'),
  ('KIOSKO','Kiosko','Kiosko','Jardín central', false,
   null,  40,  60, null, 'Exterior. Ideal para ceremonias y eventos íntimos.'),
  ('SALA-CONSEJO','Sala de Consejo','Sala de juntas','Casa Club, planta alta', true,
   null, null, null,  20, 'Mesa de consejo fija. Pantalla y videoconferencia.')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------
-- Tarifa de renta por espacio, temporada y tipo de día.
-- ---------------------------------------------------------------------
create table if not exists cot.tarifas_espacio (
  espacio          text not null references cot.espacios(clave) on delete cascade,
  temporada        text not null check (temporada in ('alta','media','baja')),
  tipo_dia         text not null check (tipo_dia in ('semana','fin')),
  tarifa_dia       numeric(12,2) not null,
  consumo_minimo   numeric(12,2) not null default 0,
  primary key (espacio, temporada, tipo_dia)
);

insert into cot.tarifas_espacio (espacio, temporada, tipo_dia, tarifa_dia, consumo_minimo) values
  ('SALON-CENTRO','alta','fin',    78000, 180000), ('SALON-CENTRO','alta','semana',  58000, 120000),
  ('SALON-CENTRO','media','fin',   62000, 140000), ('SALON-CENTRO','media','semana', 44000,  95000),
  ('SALON-CENTRO','baja','fin',    48000, 110000), ('SALON-CENTRO','baja','semana',  32000,  70000),

  ('SALON-JARDIN','alta','fin',    46000, 110000), ('SALON-JARDIN','alta','semana',  34000,  75000),
  ('SALON-JARDIN','media','fin',   37000,  88000), ('SALON-JARDIN','media','semana', 26000,  58000),
  ('SALON-JARDIN','baja','fin',    29000,  68000), ('SALON-JARDIN','baja','semana',  19000,  44000),

  ('JARDIN-LAGO','alta','fin',     68000, 150000), ('JARDIN-LAGO','alta','semana',   50000, 105000),
  ('JARDIN-LAGO','media','fin',    54000, 120000), ('JARDIN-LAGO','media','semana',  39000,  82000),
  ('JARDIN-LAGO','baja','fin',     41000,  90000), ('JARDIN-LAGO','baja','semana',   28000,  60000),

  ('TERRAZA-GOLF','alta','fin',    39000,  90000), ('TERRAZA-GOLF','alta','semana',  29000,  62000),
  ('TERRAZA-GOLF','media','fin',   31000,  72000), ('TERRAZA-GOLF','media','semana', 22000,  48000),
  ('TERRAZA-GOLF','baja','fin',    24000,  56000), ('TERRAZA-GOLF','baja','semana',  16000,  36000),

  ('KIOSKO','alta','fin',          22000,  40000), ('KIOSKO','alta','semana',        16000,  28000),
  ('KIOSKO','media','fin',         18000,  32000), ('KIOSKO','media','semana',       12000,  22000),
  ('KIOSKO','baja','fin',          14000,  26000), ('KIOSKO','baja','semana',         9000,  17000),

  ('SALA-CONSEJO','alta','fin',    14000,      0), ('SALA-CONSEJO','alta','semana',  11000,      0),
  ('SALA-CONSEJO','media','fin',   11000,      0), ('SALA-CONSEJO','media','semana',  9000,      0),
  ('SALA-CONSEJO','baja','fin',     9000,      0), ('SALA-CONSEJO','baja','semana',   7000,      0)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Paquetes de alimentos y bebidas, por persona y por día.
-- ---------------------------------------------------------------------
create table if not exists cot.paquetes_ayb (
  clave           text primary key,
  nombre          text not null,
  descripcion     text,
  precio_persona  numeric(12,2) not null,
  incluye         text,
  activo          boolean not null default true
);

insert into cot.paquetes_ayb (clave, nombre, descripcion, precio_persona, incluye) values
  ('PAQ-COFFEE','Coffee break','Dos servicios de café y panadería', 480,
   'Café, té, agua, pan dulce y fruta de temporada'),
  ('PAQ-EJECUTIVO','Paquete ejecutivo','Jornada completa de trabajo', 1850,
   'Desayuno buffet, dos coffee breaks y comida de tres tiempos'),
  ('PAQ-BANQUETE','Banquete','Cena formal de tres tiempos', 2400,
   'Cena de tres tiempos, vino de la casa y café'),
  ('PAQ-TODO','Todo incluido','Alimentos y barra libre nacional', 3600,
   'Desayuno, comida, cena, coffee breaks y barra libre nacional')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------
-- Hospedaje por tipo de habitación y temporada, por noche.
-- ---------------------------------------------------------------------
create table if not exists cot.tarifas_hospedaje (
  tipo_habitacion  text not null,
  nombre           text not null,
  temporada        text not null check (temporada in ('alta','media','baja')),
  tarifa_noche     numeric(12,2) not null,
  ocupacion_max    int not null default 2,
  primary key (tipo_habitacion, temporada)
);

insert into cot.tarifas_hospedaje (tipo_habitacion, nombre, temporada, tarifa_noche, ocupacion_max) values
  ('HAB-ESTANDAR','Habitación estándar','alta',  5400, 2),
  ('HAB-ESTANDAR','Habitación estándar','media', 4300, 2),
  ('HAB-ESTANDAR','Habitación estándar','baja',  3400, 2),
  ('HAB-JUNIOR','Junior suite','alta',           7900, 3),
  ('HAB-JUNIOR','Junior suite','media',          6300, 3),
  ('HAB-JUNIOR','Junior suite','baja',           4900, 3),
  ('HAB-SUITE','Suite','alta',                  11500, 4),
  ('HAB-SUITE','Suite','media',                  9200, 4),
  ('HAB-SUITE','Suite','baja',                   7200, 4)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Reglas de descuento.
--
-- Alejandro dijo textual que en NetSuite "No existe" una política de
-- descuento por volumen. Estas son INVENTADAS y su único propósito es
-- probar que el motor aplica reglas y explica cuál aplicó. Las reales
-- hay que levantarlas con el área comercial.
--
-- Dentro de un mismo concepto no se acumulan: gana la de mayor
-- beneficio. Entre conceptos distintos sí, porque aplican a bases
-- distintas. Eso hay que confirmarlo con comercial también.
-- ---------------------------------------------------------------------
create table if not exists cot.reglas_descuento (
  clave         text primary key,
  descripcion   text not null,
  aplica_a      text not null check (aplica_a in ('espacio','ayb','hospedaje')),
  campo         text not null check (campo in ('habitaciones','personas','dias','noches')),
  operador      text not null check (operador in ('>=','>','=','<=','<')),
  valor         numeric(12,2) not null,
  porcentaje    numeric(5,4) not null check (porcentaje between 0 and 1),
  temporada     text check (temporada in ('alta','media','baja')),
  activo        boolean not null default true
);

insert into cot.reglas_descuento
  (clave, descripcion, aplica_a, campo, operador, valor, porcentaje, temporada) values
  ('HAB-30',  'Descuento por bloque de 30 habitaciones o más',       'hospedaje','habitaciones','>=',  30, 0.10, null),
  ('HAB-50',  'Descuento por bloque de 50 habitaciones o más',       'hospedaje','habitaciones','>=',  50, 0.15, null),
  ('HAB-100', 'Descuento por bloque de 100 habitaciones o más',      'hospedaje','habitaciones','>=', 100, 0.22, null),
  ('SALON-CORTESIA','Cortesía de salón con 120 personas o más',      'espacio',  'personas',    '>=', 120, 1.00, null),
  ('SALON-3D','Descuento por evento de 3 días o más',                'espacio',  'dias',        '>=',   3, 0.15, null),
  ('AYB-150', 'Descuento en alimentos con 150 personas o más',       'ayb',      'personas',    '>=', 150, 0.08, null),
  ('BAJA-SALON','Promoción de temporada baja en renta de espacio',   'espacio',  'personas',    '>=',   1, 0.20, 'baja')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------
-- Bitácora. Sirve para comprobar que HubSpot de verdad llamó al
-- endpoint, igual que la bitácora del Concierge.
-- ---------------------------------------------------------------------
create table if not exists cot.cotizaciones (
  folio          text primary key,
  creada         timestamptz not null default now(),
  origen         text,
  hubspot_deal   text,
  peticion       jsonb not null,
  respuesta      jsonb,
  total          numeric(14,2),
  error          text
);

create index if not exists ix_cotizaciones_deal on cot.cotizaciones (hubspot_deal);

-- ---------------------------------------------------------------------
-- Seguridad y permisos. Mismo criterio que kb y lago: nada expuesto por
-- omisión, anon y authenticated sin acceso.
-- ---------------------------------------------------------------------
alter table cot.parametros        enable row level security;
alter table cot.temporadas        enable row level security;
alter table cot.espacios          enable row level security;
alter table cot.tarifas_espacio   enable row level security;
alter table cot.paquetes_ayb      enable row level security;
alter table cot.tarifas_hospedaje enable row level security;
alter table cot.reglas_descuento  enable row level security;
alter table cot.cotizaciones      enable row level security;

grant usage on schema cot to service_role;
grant select, insert, update, delete on all tables in schema cot to service_role;
grant usage, select on all sequences in schema cot to service_role;

alter default privileges in schema cot
    grant select, insert, update, delete on tables to service_role;
alter default privileges in schema cot
    grant usage, select on sequences to service_role;
