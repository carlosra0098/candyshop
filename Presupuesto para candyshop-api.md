### Resumen anual (USD, sin IVA)

| Proveedor                                | Mínimo / mes | **Mínimo / año** | Recomendado / mes | **Recomendado / año** |
| ---------------------------------------- | ------------ | ---------------- | ----------------- | --------------------- |
| **Google Cloud** (Cloud Run + Cloud SQL) | ~$10         | **~$120**        | ~$40              | **~$480**             |
| **Render**                               | $13          | **$156**         | $69               | **$828**              |
| **AWS** (App Runner + RDS)               | ~$21         | **~$252**        | ~$53              | **~$636**             |
| **Azure** (App Service + PostgreSQL)     | ~$29         | **~$351**        | ~$34              | **~$411**             |

### Desglose y fuentes

**Render** (tarifas de su página de precios):

- Mínimo: web service de 512 MB a $7 y Postgres de 256 MB a $6, con el plan Hobby a $0.
- Recomendado: plan Pro a $25, web service de 1 CPU y 2 GB a $25 y Postgres de 1 GB a $19. El plan Pro incluye 25 GB de ancho de banda, PITR de 7 días y autoscaling horizontal.
- Si te basta el plan Hobby, el recomendado baja a $44/mes (~$528/año). Hobby está pensado para proyectos personales y no incluye autoscaling horizontal.

**AWS:**

- App Runner cobra $0.064 por vCPU-hora y $0.007 por GB-hora, y mantener una instancia aprovisionada de 2 GB cuesta unos $0.34 al día. Con unas 8 horas activas al día salen ~$25/mes. [amazon](https://aws.amazon.com/id/apprunner/pricing/)
- RDS: db.t4g.micro cuesta $11.68/mes. Una db.t4g.small con 30 GB de almacenamiento y poco tráfico de salida ronda $27.71/mes. [aiven](https://aiven.io/tools/instances/db.t4g.micro)[infratally](https://infratally.com/articles/aws-rds-pricing-explained-2026/)
- Estimación Mínimo: App Runner pequeño (~$7), t4g.micro y ~20 GB. Recomendado: App Runner (~$25) más t4g.small (~$28).
- No incluye la IPv4 pública ni CloudWatch. Una arquitectura de producción real en AWS suele sumar costes extra.

**Azure:**

- App Service Basic B1 Linux cuesta $13.14/mes (1 núcleo, 1,75 GB). [microsoft](https://learn.microsoft.com/en-us/answers/a/12322935)
- PostgreSQL Flexible Server Burstable B1ms: ~$12.41/mes, con almacenamiento de 50 GB a ~$5.76/mes. Para 32 GB calculo ~$3,70. [tuke](https://git.kemt.fei.tuke.sk/mk852nc/zkt26/src/branch/main/sk1)
- Recomendado: añade Azure Container Registry Basic a ~$5/mes. [tuke](https://git.kemt.fei.tuke.sk/mk852nc/zkt26/src/branch/main/sk1)

**Google Cloud:**

- Cloud Run: $0.000024 por vCPU-segundo y $0.40 por millón de peticiones, con un nivel gratuito de 180.000 vCPU-segundos, 360.000 GiB-segundos y 2 millones de peticiones al mes. Con tu tráfico estimado el servicio web sale casi gratis en el escenario Mínimo. [goo](https://goo.gle/3Inc1KA)[cloudchipr](https://cloudchipr.com/blog/cloud-run-pricing)
- Cloud SQL: db-f1-micro ~$8/mes y db-g1-small ~$26/mes, más almacenamiento. [bytebase](https://www.bytebase.com/dbcost/cloudsql-pricing/)
- Recomendado: Cloud Run con una instancia mínima siempre activa (~$12) más db-g1-small con ~25 GB (~$28).

### Qué conviene tener en cuenta

- **Los precios son orientativos.** Las páginas que me has pasado son portales generales de precios. Para Azure, AWS y Google he usado las tarifas de sus servicios concretos y calculadoras de terceros. Algunos precios de almacenamiento son aproximados y varían por región (Europa suele costar algo más que EE. UU.).
- **No incluyen IVA** (21 % en España) ni cambio de divisa.
- **Costes que no he sumado:** dominio, tráfico de salida por encima de lo incluido, monitorización avanzada, backups extra y alta disponibilidad. La alta disponibilidad suele duplicar el coste de la base de datos.
- **Créditos:** Google Cloud da $300 a cuentas nuevas y Azure y AWS también tienen créditos o niveles gratuitos. Eso podría rebajar el primer año, pero depende de tu cuenta.

### Conclusión

- **Más barato:** Google Cloud, sobre todo si el tráfico es bajo, gracias al nivel gratuito de Cloud Run.
- **Más simple de gestionar:** Render. Cuesta más en el escenario recomendado, pero casi no requiere configuración.
- **Más predecible:** Azure, con un precio fijo mensual casi idéntico en ambos escenarios.
- **Más caro de configurar bien:** AWS, que es el más flexible pero también el que más extras puede añadir.