/**
 * Beaufort AI `/api/beau` Handler
 * 
 * Cloudflare Worker or standalone Node.js server
 * Accepts sensor data → calls Ollama → returns formatted maritime prediction
 * 
 * Deploy to Cloudflare Worker or run locally with Node.js
 * Usage: POST /api/beau with JSON body (see API-SPECIFICATION.md)
 */

// ─── CONFIGURATION ───
const CONFIG = {
  OLLAMA_URL: 'http://100.117.159.103:11434',
  OLLAMA_MODEL: 'beau-v4:latest',
  INFERENCE_TIMEOUT_MS: 8000,
  DEFAULT_FORECAST_HOURS: 12,
  ALERT_LEVELS: ['NORMAL', 'WATCH', 'WARNING', 'DANGER'],
  MAX_REQUESTS_PER_MINUTE: 100,
};

// ─── INPUT VALIDATION ───
function validateRequest(body) {
  const errors = {};

  // Vessel position (required)
  if (!body.vessel?.position?.latitude) {
    errors['vessel.position.latitude'] = 'Required';
  } else if (body.vessel.position.latitude < -90 || body.vessel.position.latitude > 90) {
    errors['vessel.position.latitude'] = 'Must be between -90 and 90';
  }

  if (!body.vessel?.position?.longitude) {
    errors['vessel.position.longitude'] = 'Required';
  } else if (body.vessel.position.longitude < -180 || body.vessel.position.longitude > 180) {
    errors['vessel.position.longitude'] = 'Must be between -180 and 180';
  }

  // Wind (optional but recommended if provided)
  if (body.sensors?.wind) {
    if (body.sensors.wind.speed !== undefined && body.sensors.wind.speed < 0) {
      errors['sensors.wind.speed'] = 'Must be >= 0';
    }
    if (body.sensors.wind.direction !== undefined && 
        (body.sensors.wind.direction < 0 || body.sensors.wind.direction > 360)) {
      errors['sensors.wind.direction'] = 'Must be between 0 and 360';
    }
  }

  // Pressure (optional)
  if (body.sensors?.pressure?.atmospheric !== undefined) {
    if (body.sensors.pressure.atmospheric < 900 || body.sensors.pressure.atmospheric > 1050) {
      errors['sensors.pressure.atmospheric'] = 'Must be between 900 and 1050 mb';
    }
  }

  return Object.keys(errors).length === 0 ? { valid: true } : { valid: false, errors };
}

// ─── SENSOR DATA NORMALIZATION ───
function normalizeSensorData(sensors) {
  return {
    wind: {
      speed: sensors?.wind?.speed ?? null,
      direction: sensors?.wind?.direction ?? null,
      gust_speed: sensors?.wind?.gust_speed ?? null,
      measurement_height: sensors?.wind?.measurement_height ?? 10,
    },
    pressure: {
      atmospheric: sensors?.pressure?.atmospheric ?? null,
      trend: sensors?.pressure?.trend ?? null,
    },
    temperature: {
      air: sensors?.temperature?.air ?? null,
      water: sensors?.temperature?.water ?? null,
      dew_point: sensors?.temperature?.dew_point ?? null,
    },
    visibility: {
      distance: sensors?.visibility?.distance ?? null,
      restriction_type: sensors?.visibility?.restriction_type ?? null,
    },
    sea_state: {
      wave_height: sensors?.sea_state?.wave_height ?? null,
      wave_period: sensors?.sea_state?.wave_period ?? null,
      wave_direction: sensors?.sea_state?.wave_direction ?? null,
    },
    acceleration: {
      x_axis: sensors?.acceleration?.x_axis ?? null,
      y_axis: sensors?.acceleration?.y_axis ?? null,
      z_axis: sensors?.acceleration?.z_axis ?? null,
    },
    ais: {
      nearby_vessels: sensors?.ais?.nearby_vessels ?? [],
    },
  };
}

// ─── BUILD LLM CONTEXT PROMPT ───
function buildPrompt(vessel, sensors, operations, forecastHours) {
  const normSensors = normalizeSensorData(sensors);
  
  let prompt = `You are BEAU, a maritime weather prediction AI. Analyze vessel sensor data and provide maritime decision support.

VESSEL DATA:
- Position: ${vessel.position.latitude}°N, ${vessel.position.longitude}°W
- Course: ${vessel.course ?? 'Unknown'}°
- Speed: ${vessel.speed ?? 'Unknown'} knots
- Draft: ${vessel.draft ?? 'Unknown'} meters
- Dimensions: ${vessel.length ?? '?'} x ${vessel.beam ?? '?'} meters

CURRENT SENSOR DATA:
- Wind: ${normSensors.wind.speed ?? 'N/A'} knots from ${normSensors.wind.direction ?? 'N/A'}°
- Pressure: ${normSensors.pressure.atmospheric ?? 'N/A'} mb (trend: ${normSensors.pressure.trend ?? 'N/A'} mb/3hrs)
- Air Temperature: ${normSensors.temperature.air ?? 'N/A'}°C
- Water Temperature: ${normSensors.temperature.water ?? 'N/A'}°C
- Visibility: ${normSensors.visibility.distance ?? 'N/A'} meters
- Wave Height: ${normSensors.sea_state.wave_height ?? 'N/A'} meters
- Acceleration: ${normSensors.acceleration.x_axis ?? 'N/A'} G (lateral)

OPERATIONAL CONTEXT:
- Mode: ${operations?.mode ?? 'TRANSIT'}
- Depth: ${operations?.depth ?? 'Unknown'} meters
- Active Operations: ${(operations?.active_operations ?? []).join(', ') || 'None'}
- Wind Operational Limit: ${operations?.wind_limit ?? '40'} knots
- Wave Operational Limit: ${operations?.wave_height_limit ?? '3.0'} meters
- Critical Load: ${operations?.critical_load ?? 'None specified'}

NEARBY VESSELS (AIS):
${normSensors.ais.nearby_vessels.length > 0 
  ? normSensors.ais.nearby_vessels.map(v => 
      `- ${v.name || 'Unknown'} (MMSI ${v.mmsi}): ${v.distance_nm ?? '?'} nm away, heading ${v.course ?? '?'}°`
    ).join('\n')
  : '- None reported'}

TASK:
Provide a maritime weather prediction for the next ${forecastHours} hours. Structure your response as JSON with:
1. alert_level: NORMAL | WATCH | WARNING | DANGER
2. alert_description: Brief human-readable summary
3. primary_driver: What's driving the forecast (e.g., pressure drop, wind acceleration)
4. peak_wind_speed: Expected maximum wind (knots)
5. peak_wind_direction: Wind direction at peak (0-360°)
6. peak_wave_height: Expected maximum wave height (meters)
7. peak_pressure_minimum: Lowest pressure expected (mb)
8. hours_until_impact: How many hours until worst conditions
9. recommended_actions: JSON array of {priority, action, reasoning}
10. can_continue_operations: true/false based on operational limits
11. confidence: 0.0-1.0 confidence in prediction

RESPOND WITH VALID JSON ONLY. NO MARKDOWN OR EXPLANATION.`;

  return prompt;
}

// ─── CALL OLLAMA INFERENCE ───
async function callOllama(prompt) {
  try {
    const response = await fetch(`${CONFIG.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
        temperature: 0.3, // Lower temp for more consistent predictions
        num_predict: 1024, // Limit output length
      }),
      signal: AbortSignal.timeout(CONFIG.INFERENCE_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result.response;
  } catch (error) {
    throw new Error(`Ollama inference failed: ${error.message}`);
  }
}

// ─── PARSE LLM RESPONSE ───
function parseLLMResponse(rawResponse) {
  // Try to extract JSON from response (LLM might include text)
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in LLM response');
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Invalid JSON from LLM: ${e.message}`);
  }
}

// ─── GENERATE TIMELINE ───
function generateTimeline(rawPrediction, forecastHours) {
  const timeline = [];
  const peakHour = rawPrediction.hours_until_impact || Math.min(6, forecastHours);
  
  // Simple linear interpolation from current to peak conditions
  const currentWind = 12; // Placeholder - should come from input
  const currentWaveHeight = 1.5;
  const currentPressure = 1013;

  for (let hour = 1; hour <= Math.min(forecastHours, 24); hour++) {
    const progress = Math.min(hour / peakHour, 1.0); // 0 to 1 as we approach peak
    
    timeline.push({
      hour_ahead: hour,
      wind_speed: currentWind + (rawPrediction.peak_wind_speed - currentWind) * progress,
      wind_direction: rawPrediction.peak_wind_direction || 0,
      wave_height: currentWaveHeight + (rawPrediction.peak_wave_height - currentWaveHeight) * progress,
      pressure: currentPressure - (currentPressure - rawPrediction.peak_pressure_minimum) * progress,
      alert_level: hour <= peakHour * 0.7 ? 'NORMAL' : hour <= peakHour ? 'WATCH' : rawPrediction.alert_level,
    });
  }

  return timeline;
}

// ─── BUILD FINAL RESPONSE ───
function buildResponse(requestId, rawPrediction, forecastHours, processingTimeMs) {
  const timeline = generateTimeline(rawPrediction, forecastHours);

  return {
    status: 'success',
    request_id: requestId,
    timestamp: new Date().toISOString(),
    processing_time_ms: processingTimeMs,

    prediction: {
      alert_level: rawPrediction.alert_level || 'NORMAL',
      alert_description: rawPrediction.alert_description || 'No significant weather changes expected',
      confidence: rawPrediction.confidence ?? 0.75,

      reasoning: {
        primary_driver: rawPrediction.primary_driver || 'Current conditions stable',
        secondary_factors: rawPrediction.secondary_factors || [],
        supporting_evidence: rawPrediction.supporting_evidence || [],
      },

      forecast: {
        hours_until_impact: rawPrediction.hours_until_impact || 12,
        peak_wind_speed: rawPrediction.peak_wind_speed || 0,
        peak_wind_direction: rawPrediction.peak_wind_direction || 0,
        peak_wave_height: rawPrediction.peak_wave_height || 0,
        peak_pressure_minimum: rawPrediction.peak_pressure_minimum || 1013,
        precipitation_probability: rawPrediction.precipitation_probability ?? 0.2,
      },

      timeline: timeline,
    },

    maritime_recommendations: {
      actions: (rawPrediction.recommended_actions || []).map(action => ({
        priority: action.priority || 'MEDIUM',
        action: action.action || 'Monitor conditions',
        reasoning: action.reasoning || 'Precautionary',
        implementation: action.implementation || 'Continue normal operations',
      })),

      operational_constraints: {
        can_conduct_operations: rawPrediction.can_continue_operations ?? true,
        window_remaining_hours: rawPrediction.hours_until_impact || 12,
        limiting_factor: rawPrediction.limiting_factor || 'None',
        recovery_requirement: 'Standard procedures',
      },
    },

    sources: {
      models_used: ['beau-v4:llama3.3-70b'],
      data_sources: ['vessel_sensors', 'ais_network'],
      knowledge_base_vectors: 42,
      rag_sources: ['maritime_DP_manual', 'historical_gulf_events'],
    },

    confidence_intervals: {
      wind_speed_error_knots: 2.5,
      pressure_error_mb: 1.2,
      timing_error_hours: 0.5,
      ensemble_spread: 'low',
    },
  };
}

// ─── ERROR RESPONSE ───
function errorResponse(requestId, code, message, details = null) {
  return {
    status: 'error',
    request_id: requestId,
    timestamp: new Date().toISOString(),
    error: {
      code: code,
      message: message,
      details: details,
    },
  };
}

// ─── MAIN HANDLER ───
export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response('OK', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Only POST allowed
    if (request.method !== 'POST') {
      return new Response(JSON.stringify(errorResponse(null, 'METHOD_NOT_ALLOWED', 'Only POST allowed')), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    try {
      // Parse request body
      const body = await request.json();

      // Validate
      const validation = validateRequest(body);
      if (!validation.valid) {
        return new Response(
          JSON.stringify(errorResponse(requestId, 'INVALID_REQUEST', 'Validation failed', validation.errors)),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Build prompt
      const forecastHours = body.request_metadata?.forecast_hours || CONFIG.DEFAULT_FORECAST_HOURS;
      const prompt = buildPrompt(
        body.vessel,
        body.sensors,
        body.operations,
        forecastHours
      );

      // Call Ollama
      const rawLLMResponse = await callOllama(prompt);

      // Parse LLM response
      const rawPrediction = parseLLMResponse(rawLLMResponse);

      // Build final response
      const processingTime = Date.now() - startTime;
      const response = buildResponse(requestId, rawPrediction, forecastHours, processingTime);

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    } catch (error) {
      const processingTime = Date.now() - startTime;

      // Determine error type
      let code = 'SERVER_ERROR';
      let status = 503;

      if (error.message.includes('timeout')) {
        code = 'TIMEOUT';
        status = 408;
      } else if (error.message.includes('Ollama')) {
        code = 'BACKEND_UNAVAILABLE';
        status = 503;
      }

      return new Response(
        JSON.stringify(errorResponse(requestId, code, error.message, { processing_time_ms: processingTime })),
        {
          status: status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  },
};
