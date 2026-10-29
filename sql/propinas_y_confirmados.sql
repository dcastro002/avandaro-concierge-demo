-- =====================================================================
-- Propinas y parámetros confirmados
-- Grupo Avándaro × Freelan · esquema cot
--
-- DE DÓNDE SALE ESTO
--
-- De una cotización real emitida por el cotizador público del propio
-- Hotel Avándaro: folio AVA-2026-10290754, del 9 al 14 de noviembre de
-- 2026, 12 personas, 6 habitaciones. Reproducimos su desglose completo
-- al centavo, lo que valida tanto sus cifras como nuestro motor.
--
-- LO QUE ESA COTIZACIÓN CONFIRMA
--
-- El ISH es 4%. Su desglose lo dice textual, "ISH (4%): $5,479.6". Ya
-- no es una deducción nuestra a partir de la aritmética.
--
-- El anticipo es 50%. "Depósito requerido: 50% del total al confirmar."
--
-- Y aparece un concepto que no teníamos: las propinas, que se cobran
-- aparte y NO causan impuestos. En su desglose, el total de hospedaje
-- con impuestos es 164,388 y las propinas se suman después, 2,760.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Lo que dejó de ser suposición
-- ---------------------------------------------------------------------
update cot.parametros
   set confirmado = true,
       descripcion = 'Impuesto sobre hospedaje. Confirmado en el desglose del cotizador público del hotel.'
 where clave = 'ish';

update cot.parametros
   set confirmado = true,
       descripcion = 'Anticipo para confirmar el evento. Confirmado: el hotel pide 50% al reservar.'
 where clave = 'anticipo_pct';

-- ---------------------------------------------------------------------
-- 2. Propinas
--
-- Se cobran por habitación, no por persona, y van después de impuestos.
-- Los montos salen de su propia cotización y están comprobados: con 6
-- habitaciones y 5 noches dan exactamente los 2,250 y 510 que listan.
-- ---------------------------------------------------------------------
insert into cot.parametros (clave, valor, descripcion, confirmado) values
  ('propina_camarista', 75.0000,
   'Propina de camaristas, por noche y por habitación. Del cotizador público del hotel.', true),
  ('propina_bellboy',   85.0000,
   'Propina de bellboys, por habitación y por estancia completa. Del cotizador público del hotel.', true),
  ('saldo_dias_antes',  15.0000,
   'Días antes del evento en que vence el saldo restante. Del cotizador público del hotel.', true)
on conflict (clave) do update
   set valor = excluded.valor,
       descripcion = excluded.descripcion,
       confirmado = excluded.confirmado;

commit;

-- =====================================================================
-- Comprobación
-- =====================================================================
select clave, valor, confirmado, descripcion
  from cot.parametros
 order by confirmado desc, clave;

-- Las propinas de su cotización, reproducidas:
--   camaristas  6 habitaciones × 5 noches × 75 = 2,250
--   bellboys    6 habitaciones × 85            =   510
select 6 * 5 * (select valor from cot.parametros where clave = 'propina_camarista') as camaristas,
       6     * (select valor from cot.parametros where clave = 'propina_bellboy')   as bellboys;
