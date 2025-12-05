import axios from "axios";
import {
  getYesterdayDateString,
  getDatePath,
  formatAppsheetDate,
} from "./utils.js";
import { getBucket, fileExists, readJSON, writeJSON } from "./bucket.js";
import { format, addDays } from "date-fns";

async function extractOne(tableName, appSheetConfig, selector = null) {
  const { appKey, appId, appsheetRegion } = appSheetConfig;
  const url = `https://${appsheetRegion}/api/v2/apps/${appId}/tables/${tableName}/Action`;
  const payload = {
    Action: "Find",
  };

  if (selector) {
    payload.Properties = {
      Selector: selector,
    };
  }

  try {
    const { data } = await axios.post(url, payload, {
      headers: {
        ApplicationAccessKey: appKey,
        "Content-Type": "application/json",
      },
    });
    console.log(`✅ Extracted ${data?.length || 0} records from ${tableName}`);
    return data;
  } catch (err) {
    console.error(
      `❌ Error extracting from ${tableName}:`,
      err.response?.data || err.message
    );
    return [];
  }
}

export async function extract(date = null) {
  const extractionDate = date || getYesterdayDateString();
  const datePath = getDatePath(extractionDate);
  const bucket = getBucket();

  // Check if extraction already exists in bucket (new YYYY/MM/DD structure)
  const bucketPath = `extractions/${datePath}/appsheet_data.json`;

  if (bucket && (await fileExists(bucket, bucketPath))) {
    console.log(`📦 Loading cached extraction from bucket: ${bucketPath}`);
    const cachedData = await readJSON(bucket, bucketPath);
    if (cachedData && cachedData.records) {
      console.log(`✅ Loaded ${cachedData.record_count} records from cache`);

      // Reconstruct usuarios map from cached data
      const usuariosMap = new Map();
      if (cachedData.usuarios) {
        for (const usuario of cachedData.usuarios) {
          const { id, ...data } = usuario;
          usuariosMap.set(id, data);
        }
      }

      return { viaje: cachedData.records, usuariosMap };
    }
  }

  // No cache found, fetch from AppSheet
  console.log("🔄 No cache found, fetching from AppSheet...");

  const appSheetConfig = {
    appKey: process.env.APP_KEY,
    appId: process.env.APP_ID,
    appsheetRegion: "www.appsheet.com",
  };

  const yesterdayDate = extractionDate;
  const today = format(addDays(yesterdayDate, 1), "MM/dd/yyyy");

  const tableConfigs = [
    {
      name: "viaje",
      selector: `Filter(viaje, AND([fecha_ultima_actualizacion] >= "${yesterdayDate}", [estado] = "Finalizado", [fecha_ultima_actualizacion] < "${today}"))`,
    },
    {
      name: "vehiculo",
    },
    {
      name: "obra",
    },
    { name: "usuario" },
    { name: "usuario_obra" },
  ];

  const data = await Promise.all(
    tableConfigs.map((config) =>
      extractOne(config.name, appSheetConfig, config.selector)
    )
  );

  const tables = {};
  tableConfigs.forEach((config, i) => {
    tables[config.name] = data[i];
  });

  const vehiculoRecords = tables.vehiculo || [];
  const vehiculoMap = new Map(
    vehiculoRecords.map((veh) => [veh["Row ID"], veh.placa])
  );

  const obraRecords = tables.obra || [];
  const obraMap = new Map(
    obraRecords.map((obra) => [obra["Row ID"], obra.nombre])
  );

  const usuarioObraRecords = tables.usuario_obra;
  const usuarioObraMap = new Map(
    usuarioObraRecords.map((uo) => [uo["Row ID"], uo])
  );

  const usuarioRecords = tables.usuario || [];
  const usuariosMap = new Map();
  for (const usuario of usuarioRecords) {
    const relatedUsuariosObras =
      usuario["Related usuario_obras"]
        ?.split(",")
        .map((id) => id.trim())
        .filter((id) => id) ?? [];

    // Get obra IDs from usuario_obra records
    const obraIds = relatedUsuariosObras
      .map((id) => usuarioObraMap.get(id)?.id_obra)
      .filter(Boolean);

    // Convert obra IDs to obra names
    const obraNames = obraIds
      .map((id) => obraMap.get(id))
      .filter(Boolean);

    usuariosMap.set(usuario["Row ID"], {
      correo: usuario["correo_electronico"],
      rol: usuario["rol"],
      relatedObras: obraNames, // Now storing names, not IDs
      estado_usuario: usuario["estado_usuario"],
      usuario: usuario["usuario"],
    });
  }

  // Extract unique placas for caching (to help Gemini with OCR)
  const uniquePlacas = [
    ...new Set(vehiculoRecords.map((veh) => veh.placa).filter(Boolean)),
  ].sort();

  tables.viaje = tables.viaje.map((v) => ({
    rowId: v["Row ID"],
    numeroVale: v.numero_vale,
    fotoVale: v.foto_vale,
    m3: v.m3_transportados,
    fecha: formatAppsheetDate(v.fecha_vale),
    placa: vehiculoMap.get(v.id_vehiculo) || "",
    obra: obraMap.get(v.id_obra),
  }));

  // Save to bucket for future use (new YYYY/MM/DD structure)
  if (bucket && tables.viaje) {
    const extractionData = {
      extraction_date: new Date().toISOString(),
      date_filter: format(yesterdayDate, "dd/MM/yyyy"),
      estado_filter: "Finalizado",
      record_count: tables.viaje.length,
      records: tables.viaje,
      valid_placas: uniquePlacas, // Cache list of valid placas
      usuarios: Array.from(usuariosMap.entries()).map(([id, data]) => ({
        id,
        ...data,
      })), // Save usuarios for email filtering
    };
    await writeJSON(bucket, bucketPath, extractionData);
  }

  return { ...tables, usuariosMap };
}
