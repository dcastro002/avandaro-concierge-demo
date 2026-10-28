-- =====================================================================
-- Estado de las conversaciones de WhatsApp
-- Grupo Avándaro × Freelan · esquema cot
--
-- POR QUÉ EXISTE
--
-- Aircall sostiene la conversación de su lado: el agente pregunta,
-- escucha y solo nos llama cuando ya tiene todo. En WhatsApp no hay
-- nadie que la sostenga, así que la memoria del hilo vive aquí.
--
-- Sin esta tabla el estado vive solo en memoria del proceso, y cada
-- despliegue de Railway, que son varios al día, borraría a media
-- conversación lo que la persona ya había dicho. Quien escribió "somos
-- 80" hace dos minutos tendría que repetirlo.
--
-- NO es una bitácora. El registro de lo que se cotizó sigue en
-- cot.cotizaciones, igual que para voz y HubSpot. Esto es nada más la
-- libreta de apuntes del hilo abierto.
-- =====================================================================

create table if not exists cot.conversaciones (
  wa_id        text primary key,
  datos        jsonb       not null default '{}'::jsonb,
  esperando    text,
  preguntado   jsonb       not null default '[]'::jsonb,
  actualizado  timestamptz not null default now(),
  creado       timestamptz not null default now()
);

comment on table  cot.conversaciones is
  'Memoria del hilo de WhatsApp mientras se junta la información. La bitácora de cotizaciones es cot.cotizaciones.';
comment on column cot.conversaciones.wa_id is
  'Número de quien escribe, como lo manda Meta. Es la llave del hilo.';
comment on column cot.conversaciones.datos is
  'Lo que lleva dicho: fecha, personas, días, habitaciones, noches, espacio, paquete.';
comment on column cot.conversaciones.esperando is
  'Qué campo contesta el siguiente mensaje. Sirve para entender un "80" sin unidad.';
comment on column cot.conversaciones.preguntado is
  'Campos opcionales que ya se preguntaron una vez, para no insistir.';

create index if not exists ix_conversaciones_actualizado
  on cot.conversaciones (actualizado desc);

-- ---------------------------------------------------------------------
-- Higiene
--
-- Un hilo sin actividad en seis horas se da por cerrado del lado del
-- código. Las filas viejas no estorban, pero tampoco sirven, y traen
-- el número de teléfono de una persona. Borrarlas es lo correcto.
--
-- Correr a mano de vez en cuando, o programar con pg_cron si se decide
-- habilitarlo:
--   select cot.limpiar_conversaciones();
-- ---------------------------------------------------------------------
create or replace function cot.limpiar_conversaciones(dias int default 7)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  delete from cot.conversaciones
   where actualizado < now() - make_interval(days => dias);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Comprobación
-- ---------------------------------------------------------------------
select 'cot.conversaciones lista' as estado,
       count(*)                  as filas
  from cot.conversaciones;
