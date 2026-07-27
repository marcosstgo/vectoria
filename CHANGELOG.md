# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado según [SemVer](https://semver.org/lang/es/).

## [0.7.0]

### Añadido

- **El motor de trazado de logos ahora se llama Cincel.** Es código propio —unas
  2.500 líneas entre `logo-tracer.js` y `resample.js`— y no envuelve ninguna
  biblioteca de trazado: el contorno subpíxel, las esquinas, el autocalibrado,
  la regularización y el ajuste de curvas son suyos.

  El nombre viene de lo que hace: sacar una forma limpia de un bloque tosco,
  quitando lo que no pertenece. Aparece en la etiqueta del motor de la barra
  inferior, en el diálogo Acerca de y en el README.

- **Atribuciones en el diálogo Acerca de**, con la licencia de cada componente
  de terceros y para qué sirve. Con licencia MIT conservar el aviso de copyright
  es un requisito, no una cortesía, y hasta ahora sólo estaba en
  `THIRD_PARTY_NOTICES.md`, que no abre nadie.

  El diálogo separa además lo propio de lo ajeno: tal como estaba daba a
  entender que todo el programa era de terceros. VTracer sólo entra cuando la
  imagen no es un logo de tintas planas.

- Logotipo completo centrado en el diálogo Acerca de, y el símbolo en la barra
  de título. Los SVG originales quedan en `docs/`.

## [0.6.0]

### Añadido

- **Detección de tramos rectos independiente de las esquinas.** Los lados rectos
  se emiten como rectas exactas y el hueco entre dos de ellos —el vértice
  redondeado— se ajusta con curvas tangentes a ambas.

  Hacía falta porque una forma geométrica con los vértices redondeados no tiene
  ninguna esquina que detectar: sus vértices son arcos, no discontinuidades. Sin
  esquinas, el contorno entero se ajustaba como una curva continua y sus lados
  rectos se disolvían dentro. Medido sobre un símbolo real: **el 99% de su
  perímetro era recto dentro de 0,25 px y salía casi todo como cúbicas**.

### Corregido

- Un rectángulo redondeado de 160×80 se aceptaba como elipse y perdía sus cuatro
  lados rectos. El límite relativo del ajuste de formas era razonable para un
  punto de 8 px pero demasiado generoso para una forma grande; ahora depende del
  tamaño, porque en una mancha pequeña el ráster no da para distinguir un
  círculo de un polígono suave y en una grande sobra información.

### Notas de método

Cuatro condiciones hicieron falta para que un tramo cuente como recto, y cada
una salió de un fallo medido:

1. **Distancia a la cuerda** dentro de la tolerancia de ajuste.
2. **Cuerda y arco casi iguales.** Sin esto, el recorrido que sube por un lado
   de un trazo fino, rodea el remate y baja por el otro también queda cerca de
   su cuerda: se aceptaba como recta y le cortaba la punta. Un asta de 2,4 px
   pasaba a medir 1,94.
3. **Giro neto casi nulo.** La distancia a la cuerda por sí sola admite hasta
   unos 16° de giro, así que una circunferencia se troceaba en rectas.
4. **Longitud mínima relativa al propio contorno.** Con un mínimo sólo absoluto,
   en una letra curva aparecían decenas de tramos cortos casi rectos y la
   palabra salía troceada, con más nodos que antes.

Además, la recta se ajusta a las muestras del tramo en vez de trazarse entre sus
extremos —la cuerda entre extremos contaminados adelgazaba el trazo— y cada
tramo se recorta un poco para dejar hueco a la curva del vértice: sin ese
recorte, un contrapunto de letra salió convertido en un triángulo.

### Medido

Los siete logos del lote siguen por debajo del 1% de error de área. La aspereza
de curvatura del banco de pruebas baja de 0,326 a 0,247, porque una recta tiene
curvatura cero. El símbolo que motivó el cambio pasa de `CCCLCCCCC` a `LCCLCCLC`.

## [0.5.0]

### Añadido

- **Salida pensada para editar.** Cada letra o forma sale como su propio objeto,
  con sus contrapuntos dentro, agrupada por tinta y con nombre. Antes todos los
  contornos de una tinta iban en un único trazado compuesto: en un logotipo con
  símbolo y texto eran 27 contornos en un solo objeto, así que en Illustrator no
  se podía mover una letra sin soltar el compuesto, y al soltarlo los
  contrapuntos dejaban de ser huecos y pasaban a ser formas rellenas encima.

  Qué es relleno y qué es hueco se decide por la profundidad de anidamiento:
  par es relleno —incluida una isla dentro de un hueco— e impar es hueco, y cada
  hueco se asigna al contorno que lo contiene más de cerca.

- **Círculos y elipses como elementos propios** (`<circle>`, `<ellipse>`) en vez
  de cuatro curvas. Illustrator los abre como objetos elipse vivos, con sus
  tiradores de tamaño.

### Medido

Marcos-Símbolo pasa de 1 objeto con 27 contornos a **19 objetos independientes**,
8 de ellos compuestos por letra y contrapunto. La geometría no cambia: el error
de área se mantiene en +0,57%.

## [0.4.0]

### Añadido

- **Logos de varias tintas.** Se detectan por agrupamiento las tintas planas del
  archivo y se traza una capa por tinta, cada una con su color. Cada píxel se
  desmezcla contra el eje fondo-tinta que mejor lo explica, de modo que un borde
  entre dos tintas no se reparte mal.

  Funciona mientras las tintas no compartan borde. Cuando lo comparten haría
  falta una topología común para que no queden ni huecos ni solapes en la
  costura, y eso sigue pendiente.

### Corregido

- Un logo de dos tintas se analizaba como si fuera de una sola: se tomaba el
  color de la tinta dominante y la otra quedaba a media cobertura. Sobre un logo
  real con símbolo lila y texto negro, **el símbolo desaparecía casi entero y
  sin ningún aviso**, que es el peor fallo posible en un conversor.

  La causa concreta era que los píxeles «núcleo» de cada tinta se seleccionaban
  por distancia al fondo superior a una fracción del máximo, y ese máximo lo
  fija la tinta más oscura: cualquier tinta clara caía por debajo del umbral y
  no llegaba siquiera a considerarse. Ahora se erosiona la máscara de tinta, que
  quita los bordes sin mirar el color.

### Medido

Lote de siete logos reales: seis ya salían con menos de 1% de error de área; el
de dos tintas pasa de **−9,86% a +0,10%**.

## [0.3.0]

Fase de **regularización**: el motor deja de perseguir únicamente el parecido al
ráster y empieza a apartarse de él a propósito, de forma controlada.

El cambio de fondo es de criterio. La fidelidad al ráster premia reproducir los
defectos del archivo de partida, así que por sí sola apunta en la dirección
equivocada para un logo. Se añadió una medida de suavidad para leerla junto a la
de fidelidad y poder decidir cuánta ceder.

### Añadido

- Control **Regularización** en la interfaz, de «Fiel al archivo» a «Idealizar».
  Sube en el modo Logo y baja en Dibujo, donde una ondulación puede ser
  intencionada.
- Pestaña **Diferencias** en el visor: rojo donde el trazado añade tinta,
  naranja donde le falta, con recuento. Es la herramienta con la que se
  encontraron casi todos los defectos del motor.
- **Fairing**: se alisa la dirección de la tangente a lo largo del arco y se
  reconstruye el contorno integrándola, por tramos entre esquinas y con un
  presupuesto máximo de desviación.
- **Ajuste de formas completas**: los contornos que son círculos o elipses se
  emiten como la forma exacta con cuatro cúbicas.
- **Regularización de anchura de trazo**: se mide la anchura local buscando el
  punto de enfrente y se corrige hacia la que toca.
- **Eliminación de nodos**: pasada que intenta borrar cada unión y reajustar el
  tramo unido.
- **Métrica de aspereza de curvatura** en el banco de pruebas, junto al IoU.
- Versión visible en la barra superior.

### Corregido

- `Number(settings.detail) || 1` convertía el perfil **Simple (0)** en
  Equilibrado. Ese perfil no había funcionado nunca.
- Las operaciones con radio de acción (alisado, regularización, refinado de
  esquinas) no se limitaban al grosor de lo que tocaban. Sobre un texto de 2,2 px
  de asta, la regularización engordaba las astas un 14% y el refinado de
  esquinas, con 3 px de margen, sacaba picos en las letras.

### Medido

- Logo caligráfico real: 397 → 274 nodos, 14,5 → 11,1 KB.
- Texto pequeño de un logotipo: variación de grosor dentro de cada asta del
  18,96% que trae el ráster al 9,33%.
- Frente a vectorizer.ai sobre el mismo logo, rasterizando ambos a la misma
  escala y alineados por el recuadro de tinta: área de tinta a 0,1% y
  complejidad de contorno (perímetro²/área) a 0,3%.

## [0.2.0]

Fase de **precisión**: el trazador pasa de aproximar contornos a reconstruirlos.

### Añadido

- **Detección y preservación de esquinas**: detector en dos escalas que
  distingue una esquina real de una curva cerrada comparando cómo crece el giro,
  refinado del vértice por intersección de las dos rectas ajustadas, alisado
  anulado en las esquinas y ajuste por tramos con tangentes de un solo lado.
- **Modo mate**: los logos opacos sobre fondo sólido ya no caen a VTracer.
- **Remuestreo propio** (`src/resample.js`) con núcleo Mitchell para ampliar y
  Lanczos-3 para reducir, con alfa premultiplicado y ampliaciones a factor
  entero.
- **Autocalibrado**: se mide el ruido de extracción de cada archivo con un
  filtro cuadrático local y se escalan con él la tolerancia y el alisado.
- **Banco de pruebas** (`npm run bench`) que mide fidelidad, desvío en vértices
  y número de comandos sobre formas sintéticas con antialias exacto, y acepta
  otro motor como argumento para comparar.

### Corregido

- El ajuste de curvas compartía la tangente en cada corte, así que era
  matemáticamente incapaz de producir un vértice en punta.
- Los contornos que no cerraban se descartaban en silencio, y las celdas
  ambiguas se resolvían tomando la primera rama libre.
- Las áreas mínimas estaban en píxeles del espacio de trabajo, no del original,
  y se comían los puntos de las íes en imágenes pequeñas.

### Medido

Frente a 0.1.0, perfil Equilibrado:

| Forma | IoU | Desvío en vértice | Comandos |
| --- | --- | --- | --- |
| Cuadrado girado | 0,99517 → 0,99991 | 0,562 → 0,009 px | 14 → 4 |
| Letra con asta y contrapunto | 0,96689 → 0,99687 | 0,544 → 0,000 px | 18 → 14 |
| Estrella de 5 puntas | 0,99061 → 0,99879 | 1,418 → 0,024 px | 32 → 10 |

## [0.1.0]

Versión inicial: trazado multicolor con VTracer, trazador propio de contorno
subpíxel para PNG transparentes casi monocromáticos, limpieza de fondo,
comparación interactiva, tres perfiles y exportación SVG/PDF.
