// GraphHopper 10.x config builder.
//
// GH 9+ removed the old `vehicle:`/`weighting:` profile syntax (config
// migration 08→09). Profiles now reference bundled custom-model templates via
// `custom_model_files`, and every encoded value those models use must be listed
// in `graph.encoded_values`. The list below covers GH's bundled car/bike/foot
// models (bike/foot reference mtb_rating + hike_rating).

const PROFILES_BLOCK = `  profiles:
    - name: car
      custom_model_files: [car.json]
    - name: bike
      custom_model_files: [bike.json]
    - name: foot
      custom_model_files: [foot.json]
  graph.encoded_values: car_access, car_average_speed, bike_priority, mtb_rating, hike_rating, bike_access, roundabout, bike_average_speed, foot_access, foot_priority, foot_average_speed`

function baseBlock(pbfPath: string, graphDir: string): string {
  return `graphhopper:
  datareader.file: "${pbfPath}"
  graph.location: "${graphDir}"
  import.osm.ignored_highways: ''
  graph.dataaccess.default_type: RAM_STORE
${PROFILES_BLOCK}`
}

/** Config for `graphhopper.jar import` — builds the routing graph, no server. */
export function ghImportConfigYaml(pbfPath: string, graphDir: string): string {
  return baseBlock(pbfPath, graphDir) + '\n'
}

/** Config for `graphhopper.jar server` — serves routes from a prebuilt graph. */
export function ghServerConfigYaml(pbfPath: string, graphDir: string, port: number): string {
  return `${baseBlock(pbfPath, graphDir)}
server:
  application_connectors:
    - type: http
      port: ${port}
      bind_host: 127.0.0.1
  admin_connectors:
    - type: http
      port: ${port + 1}
      bind_host: 127.0.0.1
`
}
