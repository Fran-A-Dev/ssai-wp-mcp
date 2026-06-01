import { tool } from "ai";
import { z } from "zod";

export const weatherTool = tool({
  description:
    "Get the current weather information for a specific location. Use this to answer questions about the weather in different cities.",
  parameters: z.object({
    location: z
      .string()
      .describe(
        "The location for which to get the current weather information."
      ),
  }),
  execute: async ({ location }: { location: string }) => {
    console.log(`[Tool Execution] Getting weather for location: "${location}"`);
    try {
      // Simulate fetching weather data
      const weatherData = {
        location,
        temperature: "22°C",
        condition: "Sunny",
        humidity: "60%",
        windSpeed: "15 km/h",
      };
      const formattedWeather = `The current weather in ${weatherData.location} is ${weatherData.temperature} with ${weatherData.condition}. Humidity is at ${weatherData.humidity} and wind speed is ${weatherData.windSpeed}.`;
      return { weather: formattedWeather };
    } catch (error: any) {
      console.error("[Tool Execution] Exception:", error);
      return {
        error: `An error occurred while fetching weather data: ${error.message}`,
      };
    }
  },
});
