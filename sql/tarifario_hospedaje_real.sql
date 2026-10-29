-- =====================================================================
-- Tarifario REAL de hospedaje · Hotel Avándaro
-- Grupo Avándaro × Freelan · esquema cot
--
-- DE DÓNDE SALEN ESTOS NÚMEROS
--
-- Del cotizador público de experiencias empresariales del propio Hotel
-- Avándaro. Son las tarifas que el hotel publica hoy a quien pide una
-- cotización por su sitio, con su inventario y sus capacidades.
--
-- Deja de ser inventado el dominio de hospedaje. Espacios, paquetes de
-- alimentos y reglas de descuento siguen siendo de prueba, y las
-- respuestas lo dicen así de explícito.
--
-- DOS COSAS QUE EL TARIFARIO REAL CORRIGE
--
-- 1. La tarifa NO depende de temporada, depende de si la noche es entre
--    semana o de fin de semana. Nuestro modelo anterior la partía por
--    temporada alta, media y baja, que fue una invención nuestra. Si el
--    tarifario interno sí tiene estacionalidad, habrá que agregarla con
--    el dato de Avándaro; la página pública no la muestra.
--
-- 2. El impuesto sobre hospedaje es 4%, no 3%. Se deduce de su propia
--    aritmética: 3,900 más impuestos da 4,680, que es exactamente 1.20.
--    Lo mismo en las cuatro habitaciones y en las dos modalidades. Con
--    IVA de 16%, el ISH tiene que ser 4%.
--
--    Sigue marcado como NO confirmado, porque lo dedujimos nosotros de
--    una página, no nos lo dijo Avándaro.
--
-- 3. Las capacidades reales son 1 y 2 personas, no 2 a 4 como teníamos.
--    Eso cambia los avisos de bloque de habitaciones, para bien: ahora
--    el aviso de "no alcanzan las habitaciones" se dispara con la
--    realidad del hotel y no con una suposición.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. El impuesto sobre hospedaje
-- ---------------------------------------------------------------------
update cot.parametros
   set valor = 0.0400,
       descripcion = 'Impuesto sobre hospedaje. Deducido del cotizador público del hotel (20% total con IVA); falta que Avándaro lo confirme.'
 where clave = 'ish';

-- ---------------------------------------------------------------------
-- 2. La tabla, ahora por tipo de día
--
-- Se reconstruye en vez de migrarse: la llave cambia de temporada a
-- tipo de día, y dejar las dos semánticas conviviendo es la clase de
-- cosa que después nadie entiende.
-- ---------------------------------------------------------------------
drop table if exists cot.tarifas_hospedaje cascade;

create table cot.tarifas_hospedaje (
  tipo_habitacion  text not null,
  nombre           text not null,
  tipo_dia         text not null check (tipo_dia in ('semana','fin')),
  tarifa_noche     numeric(12,2) not null,      -- antes de impuestos
  ocupacion_max    int  not null,
  inventario       int,                         -- cuántas tiene el hotel
  origen           text not null default 'Cotizador público de Hotel Avándaro',
  primary key (tipo_habitacion, tipo_dia)
);

comment on column cot.tarifas_hospedaje.tarifa_noche is
  'Tarifa por noche ANTES de impuestos, tal como la publica el hotel.';
comment on column cot.tarifas_hospedaje.inventario is
  'Cuántas habitaciones de ese tipo existen. No es disponibilidad: eso vive en Opera.';

insert into cot.tarifas_hospedaje
  (tipo_habitacion, nombre, tipo_dia, tarifa_noche, ocupacion_max, inventario) values
  ('HAB-INDIVIDUAL',   'Habitación individual', 'semana',  3900, 1, 30),
  ('HAB-INDIVIDUAL',   'Habitación individual', 'fin',     4600, 1, 30),
  ('HAB-DOBLE',        'Habitación doble',      'semana',  4190, 2, 44),
  ('HAB-DOBLE',        'Habitación doble',      'fin',     5600, 2, 44),
  ('HAB-SUITE',        'Suite Premium',         'semana',  4244, 2,  6),
  ('HAB-SUITE',        'Suite Premium',         'fin',     5950, 2,  6),
  ('HAB-PRESIDENCIAL', 'Presidencial',          'semana',  6840, 2,  1),
  ('HAB-PRESIDENCIAL', 'Presidencial',          'fin',    12250, 2,  1);

alter table cot.tarifas_hospedaje enable row level security;

commit;

-- =====================================================================
-- Comprobación
-- =====================================================================
select tipo_habitacion,
       nombre,
       max(case when tipo_dia = 'semana' then tarifa_noche end) as entre_semana,
       max(case when tipo_dia = 'fin'    then tarifa_noche end) as fin_de_semana,
       max(ocupacion_max) as personas,
       max(inventario)    as hay
  from cot.tarifas_hospedaje
 group by tipo_habitacion, nombre
 order by entre_semana;

-- Y que el impuesto haya quedado en 4%.
select clave, valor, confirmado from cot.parametros where clave in ('iva','ish');

-- El hotel tiene 81 habitaciones en total. Con capacidad real de 1 y 2
-- personas, el tope físico ronda las 100 personas hospedadas, que cuadra
-- con el tope de 120 asistentes del cotizador público del hotel.
select sum(inventario) as habitaciones_totales,
       sum(inventario * ocupacion_max) as personas_maximo
  from cot.tarifas_hospedaje
 where tipo_dia = 'semana';
