-- Detalle estructurado del fallo de un run: los `details` del AppError (por
-- ejemplo, que campo del schema no valido) o los ultimos logs del contenedor
-- del agente. Sin esto un INTERNAL_ERROR quedaba sin ninguna pista.
ALTER TABLE `runs` ADD `error_detail` text;
